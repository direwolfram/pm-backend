import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import {
  computeSellable,
  isLowStock,
  pickPriorityScore,
  shelfLifeDaysRemaining,
} from "./lib/inventoryMath";
import { getBoundingBox, haversineDistance } from "./lib/geo";
import type { Id as ConvexId } from "./_generated/dataModel";

type InventoryId = ConvexId<"inventory">;
type ProductId = ConvexId<"products">;
type CenterId = ConvexId<"fulfillmentCenters">;
type BatchId = ConvexId<"batches">;
type ReservationId = ConvexId<"cartReservations">;
type UserId = ConvexId<"users">;

interface QuickInventoryDoc {
  _id: InventoryId;
  sku?: string;
  productId?: ProductId;
  fulfillmentCenterId?: CenterId;
  availableQuantity?: number;
  reservedQuantity?: number;
  inboundQuantity?: number;
  maxOrderQuantity?: number;
  replenishmentThreshold?: number;
  expectedReplenishmentAt?: number;
  lastUpdatedAt?: number;
  isActive?: boolean;
  isLowStock?: boolean;
}

interface ProductDoc {
  _id: ProductId;
  sku?: string;
  name: string;
  description?: string;
  basePrice?: number;
  brand?: string;
  weightKg?: number;
  volumeL?: number;
  isFragile?: boolean;
  isFlammable?: boolean;
  temperatureZone?: "ambient" | "chilled" | "frozen";
  packagingType?: string;
  isFreshProduce?: boolean;
  isReturnable?: boolean;
  isExpressAvailable?: boolean;
  isFrequentlyBought?: boolean;
  substituteSkuIds?: string[];
  substitutePriority?: number;
  allowSubstitution?: boolean;
}

interface FulfillmentCenterDoc {
  _id: CenterId;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  serviceablePincodes: string[];
  isActive: boolean;
}

interface BatchDoc {
  _id: BatchId;
  inventoryId: InventoryId;
  batchNumber: string;
  quantity: number;
  expiryDate: number;
  manufacturedDate?: number;
  harvestDate?: number;
  shelfLifeDaysRemaining: number;
  isNearExpiry: boolean;
  discountPercent: number;
  qualityCheckStatus: "pending" | "passed" | "failed";
  pickPriority: number;
  expiredAt?: number;
}

interface DeliverySlotDoc {
  _id: ConvexId<"deliverySlots">;
  fulfillmentCenterId: CenterId;
  slotStart: number;
  slotEnd: number;
  durationMinutes: number;
  maxCapacity: number;
  currentOrders: number;
  isRushHour: boolean;
  isAvailable: boolean;
}

interface CartReservationDoc {
  _id: ReservationId;
  userId: UserId;
  inventoryId: InventoryId;
  quantity: number;
  reservedAt: number;
  expiresAt: number;
  status: "active" | "converted" | "expired" | "released";
}

interface InventoryPricingDoc {
  _id: ConvexId<"inventoryPricing">;
  inventoryId: InventoryId;
  dynamicPrice: number;
  flashSaleReservedQty: number;
  membershipExclusiveQty: number;
  discountStartAt?: number;
  discountEndAt?: number;
  isSurgeActive: boolean;
}

const qualityCheckStatus = v.union(
  v.literal("pending"),
  v.literal("passed"),
  v.literal("failed"),
);

function now(): number {
  return Date.now();
}

function assertPositiveQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("quantity must be greater than 0");
  }
}

function requireQuickInventory(row: QuickInventoryDoc | null): QuickInventoryDoc {
  if (!row) throw new Error("Inventory row not found");
  if (
    row.sku === undefined ||
    row.productId === undefined ||
    row.fulfillmentCenterId === undefined ||
    row.availableQuantity === undefined ||
    row.reservedQuantity === undefined ||
    row.maxOrderQuantity === undefined ||
    row.replenishmentThreshold === undefined
  ) {
    throw new Error("Inventory row is missing quick-commerce fields");
  }
  return row;
}

function withComputed(row: QuickInventoryDoc) {
  const available = row.availableQuantity ?? 0;
  const reserved = row.reservedQuantity ?? 0;
  const threshold = row.replenishmentThreshold ?? 0;
  const sellableQuantity = computeSellable(available, reserved);
  return {
    ...row,
    sellableQuantity,
    isLowStock: isLowStock(sellableQuantity, threshold),
    isOutOfStock: sellableQuantity <= 0,
  };
}

function stockStatus(row: QuickInventoryDoc): "in_stock" | "low_stock" | "out_of_stock" | "unavailable" {
  if (row.isActive === false) return "unavailable";
  const computed = withComputed(row);
  if (computed.isOutOfStock) return "out_of_stock";
  if (computed.isLowStock) return "low_stock";
  return "in_stock";
}

function quickInventoryPatch(
  availableQuantity: number,
  reservedQuantity: number,
  replenishmentThreshold: number,
) {
  const sellable = computeSellable(availableQuantity, reservedQuantity);
  return {
    availableQuantity,
    reservedQuantity,
    isLowStock: isLowStock(sellable, replenishmentThreshold),
    lastUpdatedAt: now(),
  };
}

export const getInventoryBySkuAndCenter = query({
  args: {
    sku: v.string(),
    fulfillmentCenterId: v.id("fulfillmentCenters"),
  },
  handler: async (ctx, args) => {
    const rows = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_center", (q) => q.eq("sku", args.sku))
      .collect()) as QuickInventoryDoc[];
    const row = rows.find(
      (candidate) => candidate.fulfillmentCenterId === args.fulfillmentCenterId,
    );
    return row ? withComputed(row) : null;
  },
});

export const listFulfillmentCenters = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const centers = (await ctx.db.query("fulfillmentCenters").collect()) as FulfillmentCenterDoc[];
    return centers
      .filter((center) => args.includeInactive || center.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const summaryByCenter = query({
  args: { fulfillmentCenterId: v.optional(v.id("fulfillmentCenters")) },
  handler: async (ctx, args) => {
    const rows = args.fulfillmentCenterId
      ? ((await ctx.db
          .query("inventory")
          .withIndex("by_center_active", (q) =>
            q.eq("fulfillmentCenterId", args.fulfillmentCenterId!),
          )
          .collect()) as QuickInventoryDoc[])
      : ((await ctx.db.query("inventory").collect()) as QuickInventoryDoc[]);
    const quickRows = rows.filter((row) => row.sku && row.productId && row.fulfillmentCenterId);
    const summary = {
      total_skus: quickRows.length,
      active_skus: 0,
      in_stock: 0,
      low_stock: 0,
      out_of_stock: 0,
      unavailable: 0,
      available_units: 0,
      reserved_units: 0,
      inbound_units: 0,
      sellable_units: 0,
    };
    for (const row of quickRows) {
      if (row.isActive !== false) summary.active_skus += 1;
      const status = stockStatus(row);
      summary[status] += 1;
      summary.available_units += row.availableQuantity ?? 0;
      summary.reserved_units += row.reservedQuantity ?? 0;
      summary.inbound_units += row.inboundQuantity ?? 0;
      summary.sellable_units += computeSellable(
        row.availableQuantity ?? 0,
        row.reservedQuantity ?? 0,
      );
    }
    return summary;
  },
});

export const listByCenter = query({
  args: {
    fulfillmentCenterId: v.optional(v.id("fulfillmentCenters")),
    status: v.optional(
      v.union(
        v.literal("in_stock"),
        v.literal("low_stock"),
        v.literal("out_of_stock"),
        v.literal("unavailable"),
      ),
    ),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rawRows = args.fulfillmentCenterId
      ? ((await ctx.db
          .query("inventory")
          .withIndex("by_center_active", (q) =>
            q.eq("fulfillmentCenterId", args.fulfillmentCenterId!),
          )
          .collect()) as QuickInventoryDoc[])
      : ((await ctx.db.query("inventory").collect()) as QuickInventoryDoc[]);
    const rows = rawRows.filter((row) => row.sku && row.productId && row.fulfillmentCenterId);
    const centerIds = Array.from(new Set(rows.map((row) => row.fulfillmentCenterId!)));
    const centers = new Map<CenterId, FulfillmentCenterDoc>();
    for (const centerId of centerIds) {
      const center = (await ctx.db.get(centerId)) as FulfillmentCenterDoc | null;
      if (center) centers.set(centerId, center);
    }

    const out = [];
    for (const row of rows) {
      const product = (await ctx.db.get(row.productId!)) as ProductDoc | null;
      const center = centers.get(row.fulfillmentCenterId!);
      const pricing = (await ctx.db
        .query("inventoryPricing")
        .withIndex("by_inventory", (q) => q.eq("inventoryId", row._id))
        .first()) as InventoryPricingDoc | null;
      const batches = (await ctx.db
        .query("batches")
        .withIndex("by_inventory_expiry", (q) => q.eq("inventoryId", row._id))
        .collect()) as BatchDoc[];
      const computed = withComputed(row);
      const statusValue = stockStatus(row);
      if (args.status && statusValue !== args.status) continue;
      const searchable = `${row.sku ?? ""} ${product?.name ?? ""} ${product?.brand ?? ""} ${center?.name ?? ""}`.toLowerCase();
      if (args.search && !searchable.includes(args.search.toLowerCase())) continue;
      out.push({
        ...computed,
        status: statusValue,
        product,
        fulfillmentCenter: center,
        pricing,
        batchCount: batches.length,
        nearExpiryBatchCount: batches.filter((batch) => batch.isNearExpiry).length,
        earliestExpiryDate: batches[0]?.expiryDate,
      });
    }
    out.sort((a, b) => {
      if (a.status !== b.status) return a.status.localeCompare(b.status);
      return (a.product?.name ?? a.sku ?? "").localeCompare(b.product?.name ?? b.sku ?? "");
    });
    return out.slice(0, Math.min(Math.max(args.limit ?? 300, 1), 500));
  },
});

export const getSellableQuantity = query({
  args: { inventoryId: v.id("inventory") },
  handler: async (ctx, args) => {
    const row = requireQuickInventory(
      (await ctx.db.get(args.inventoryId)) as QuickInventoryDoc | null,
    );
    return computeSellable(row.availableQuantity!, row.reservedQuantity!);
  },
});

export const getNearbyCenters = query({
  args: {
    latitude: v.number(),
    longitude: v.number(),
    radiusKm: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.radiusKm <= 0) throw new Error("radiusKm must be greater than 0");
    const box = getBoundingBox(args.latitude, args.longitude, args.radiusKm);
    const centers = (await ctx.db
      .query("fulfillmentCenters")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect()) as FulfillmentCenterDoc[];

    return centers
      .filter(
        (center) =>
          center.latitude >= box.minLat &&
          center.latitude <= box.maxLat &&
          center.longitude >= box.minLng &&
          center.longitude <= box.maxLng,
      )
      .map((center) => ({
        ...center,
        distanceKm: haversineDistance(
          args.latitude,
          args.longitude,
          center.latitude,
          center.longitude,
        ),
      }))
      .filter((center) => center.distanceKm <= args.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  },
});

export const getInventoryByPincode = query({
  args: {
    pincode: v.string(),
    sku: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const centers = (await ctx.db
      .query("fulfillmentCenters")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect()) as FulfillmentCenterDoc[];
    const servingCenters = centers.filter((center) =>
      center.serviceablePincodes.includes(args.pincode),
    );

    const rows = [];
    for (const center of servingCenters) {
      const inventory = (await ctx.db
        .query("inventory")
        .withIndex("by_center_active", (q) => q.eq("fulfillmentCenterId", center._id))
        .collect()) as QuickInventoryDoc[];
      for (const row of inventory) {
        if (row.isActive !== true) continue;
        if (args.sku && row.sku !== args.sku) continue;
        rows.push({ ...withComputed(row), fulfillmentCenter: center });
      }
    }
    return rows;
  },
});

export const getCartReservations = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const reservations = (await ctx.db
      .query("cartReservations")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect()) as CartReservationDoc[];
    const active = reservations.filter((reservation) => reservation.status === "active");
    const rows = [];
    for (const reservation of active) {
      const inventory = (await ctx.db.get(
        reservation.inventoryId,
      )) as QuickInventoryDoc | null;
      const product = inventory?.productId
        ? ((await ctx.db.get(inventory.productId)) as ProductDoc | null)
        : null;
      rows.push({
        ...reservation,
        inventory: inventory ? withComputed(inventory) : null,
        product,
      });
    }
    return rows;
  },
});

export const getDeliverySlots = query({
  args: {
    fulfillmentCenterId: v.id("fulfillmentCenters"),
    from: v.number(),
    to: v.number(),
  },
  handler: async (ctx, args) => {
    const slots = (await ctx.db
      .query("deliverySlots")
      .withIndex("by_center_time", (q) =>
        q.eq("fulfillmentCenterId", args.fulfillmentCenterId),
      )
      .collect()) as DeliverySlotDoc[];
    return slots
      .filter(
        (slot) =>
          slot.slotStart >= args.from && slot.slotStart <= args.to && slot.isAvailable,
      )
      .map((slot) => ({
        ...slot,
        remainingCapacity: Math.max(slot.maxCapacity - slot.currentOrders, 0),
      }))
      .filter((slot) => slot.remainingCapacity > 0)
      .sort((a, b) => a.slotStart - b.slotStart);
  },
});

export const getSubstitutes = query({
  args: {
    sku: v.string(),
    fulfillmentCenterId: v.id("fulfillmentCenters"),
  },
  handler: async (ctx, args) => {
    const product = (await ctx.db
      .query("products")
      .withIndex("by_sku", (q) => q.eq("sku", args.sku))
      .first()) as ProductDoc | null;
    if (!product?.allowSubstitution || !product.substituteSkuIds?.length) return [];

    const substitutes = [];
    for (const substituteSku of product.substituteSkuIds) {
      const substituteProduct = (await ctx.db
        .query("products")
        .withIndex("by_sku", (q) => q.eq("sku", substituteSku))
        .first()) as ProductDoc | null;
      if (!substituteProduct) continue;
      const inventoryRows = (await ctx.db
        .query("inventory")
        .withIndex("by_sku_center", (q) => q.eq("sku", substituteSku))
        .collect()) as QuickInventoryDoc[];
      const inventory = inventoryRows.find(
        (candidate) => candidate.fulfillmentCenterId === args.fulfillmentCenterId,
      );
      if (!inventory || inventory.fulfillmentCenterId !== args.fulfillmentCenterId) continue;
      const computed = withComputed(inventory);
      if (computed.sellableQuantity <= 0) continue;
      substitutes.push({ product: substituteProduct, inventory: computed });
    }
    return substitutes.sort(
      (a, b) =>
        (a.product.substitutePriority ?? Number.MAX_SAFE_INTEGER) -
        (b.product.substitutePriority ?? Number.MAX_SAFE_INTEGER),
    );
  },
});

export const getNearExpiryBatches = query({
  args: { fulfillmentCenterId: v.id("fulfillmentCenters") },
  handler: async (ctx, args) => {
    const inventory = (await ctx.db
      .query("inventory")
      .withIndex("by_center_active", (q) =>
        q.eq("fulfillmentCenterId", args.fulfillmentCenterId),
      )
      .collect()) as QuickInventoryDoc[];
    const inventoryIds = new Set(
      inventory.filter((row) => row.isActive === true).map((row) => row._id),
    );
    const batches = (await ctx.db
      .query("batches")
      .withIndex("by_near_expiry", (q) => q.eq("isNearExpiry", true))
      .collect()) as BatchDoc[];
    return batches
      .filter((batch) => inventoryIds.has(batch.inventoryId))
      .sort((a, b) => a.expiryDate - b.expiryDate);
  },
});

export const reserveInventory = mutation({
  args: {
    inventoryId: v.id("inventory"),
    quantity: v.number(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    assertPositiveQuantity(args.quantity);
    const row = requireQuickInventory(
      (await ctx.db.get(args.inventoryId)) as QuickInventoryDoc | null,
    );
    if (row.isActive === false) {
      return { success: false, reason: "inactive_inventory", available: 0 };
    }
    if (args.quantity > row.maxOrderQuantity!) {
      return {
        success: false,
        reason: "max_order_quantity_exceeded",
        maxOrderQuantity: row.maxOrderQuantity,
      };
    }

    const sellable = computeSellable(row.availableQuantity!, row.reservedQuantity!);
    if (sellable < args.quantity) {
      return { success: false, reason: "insufficient_stock", available: sellable };
    }

    const reservedAt = now();
    await ctx.db.patch(args.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity!,
        row.reservedQuantity! + args.quantity,
        row.replenishmentThreshold!,
      ),
    });
    const reservationId = await ctx.db.insert("cartReservations", {
      userId: args.userId,
      inventoryId: args.inventoryId,
      quantity: args.quantity,
      reservedAt,
      expiresAt: reservedAt + 10 * 60 * 1000,
      status: "active",
    });
    return { success: true, reservationId };
  },
});

export const releaseReservation = mutation({
  args: { reservationId: v.id("cartReservations") },
  handler: async (ctx, args) => {
    const reservation = (await ctx.db.get(
      args.reservationId,
    )) as CartReservationDoc | null;
    if (!reservation) throw new Error("Reservation not found");
    if (reservation.status !== "active") {
      return { success: true, status: reservation.status };
    }
    const row = requireQuickInventory(
      (await ctx.db.get(reservation.inventoryId)) as QuickInventoryDoc | null,
    );
    await ctx.db.patch(reservation.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity!,
        Math.max(row.reservedQuantity! - reservation.quantity, 0),
        row.replenishmentThreshold!,
      ),
    });
    await ctx.db.patch(reservation._id, { status: "released" });
    return { success: true, status: "released" };
  },
});

export const convertReservation = mutation({
  args: { reservationId: v.id("cartReservations") },
  handler: async (ctx, args) => {
    const reservation = (await ctx.db.get(
      args.reservationId,
    )) as CartReservationDoc | null;
    if (!reservation) throw new Error("Reservation not found");
    if (reservation.status !== "active") {
      return { success: true, status: reservation.status };
    }
    const row = requireQuickInventory(
      (await ctx.db.get(reservation.inventoryId)) as QuickInventoryDoc | null,
    );
    if (row.availableQuantity! < reservation.quantity) {
      throw new Error("Reserved quantity exceeds available inventory");
    }
    await ctx.db.patch(reservation.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity! - reservation.quantity,
        Math.max(row.reservedQuantity! - reservation.quantity, 0),
        row.replenishmentThreshold!,
      ),
    });
    await ctx.db.patch(reservation._id, { status: "converted" });
    return { success: true, status: "converted" };
  },
});

export const updateInventory = mutation({
  args: {
    inventoryId: v.id("inventory"),
    adjustment: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.adjustment)) {
      throw new Error("adjustment must be a finite number");
    }
    const row = requireQuickInventory(
      (await ctx.db.get(args.inventoryId)) as QuickInventoryDoc | null,
    );
    const previousAvailable = row.availableQuantity!;
    const nextAvailable = previousAvailable + args.adjustment;
    if (nextAvailable < 0) {
      throw new Error("Adjustment would make availableQuantity negative");
    }
    await ctx.db.patch(args.inventoryId, {
      ...quickInventoryPatch(nextAvailable, row.reservedQuantity!, row.replenishmentThreshold!),
    });
    await ctx.db.insert("inventoryLogs", {
      inventoryId: args.inventoryId,
      adjustment: args.adjustment,
      reason: args.reason,
      previousAvailableQuantity: previousAvailable,
      nextAvailableQuantity: nextAvailable,
      createdAt: now(),
    });
    return { availableQuantity: nextAvailable };
  },
});

export const createBatch = mutation({
  args: {
    inventoryId: v.id("inventory"),
    batchNumber: v.string(),
    quantity: v.number(),
    expiryDate: v.number(),
    manufacturedDate: v.optional(v.number()),
    harvestDate: v.optional(v.number()),
    discountPercent: v.optional(v.number()),
    qualityCheckStatus: v.optional(qualityCheckStatus),
  },
  handler: async (ctx, args) => {
    assertPositiveQuantity(args.quantity);
    const row = requireQuickInventory(
      (await ctx.db.get(args.inventoryId)) as QuickInventoryDoc | null,
    );
    const t = now();
    const daysRemaining = shelfLifeDaysRemaining(args.expiryDate, t);
    const batchId = await ctx.db.insert("batches", {
      inventoryId: args.inventoryId,
      batchNumber: args.batchNumber,
      quantity: args.quantity,
      expiryDate: args.expiryDate,
      manufacturedDate: args.manufacturedDate,
      harvestDate: args.harvestDate,
      shelfLifeDaysRemaining: daysRemaining,
      isNearExpiry: daysRemaining <= 2,
      discountPercent: args.discountPercent ?? 0,
      qualityCheckStatus: args.qualityCheckStatus ?? "pending",
      pickPriority: pickPriorityScore(args.expiryDate),
    });
    await ctx.db.patch(args.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity! + args.quantity,
        row.reservedQuantity!,
        row.replenishmentThreshold!,
      ),
    });
    return batchId;
  },
});

export const markBatchExpired = mutation({
  args: { batchId: v.id("batches") },
  handler: async (ctx, args) => {
    const batch = (await ctx.db.get(args.batchId)) as BatchDoc | null;
    if (!batch) throw new Error("Batch not found");
    if (batch.expiredAt !== undefined || batch.quantity <= 0) {
      return { success: true, alreadyExpired: true };
    }
    const row = requireQuickInventory(
      (await ctx.db.get(batch.inventoryId)) as QuickInventoryDoc | null,
    );
    const decrement = Math.min(batch.quantity, row.availableQuantity!);
    await ctx.db.patch(batch.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity! - decrement,
        row.reservedQuantity!,
        row.replenishmentThreshold!,
      ),
    });
    await ctx.db.patch(args.batchId, {
      quantity: 0,
      qualityCheckStatus: "failed",
      expiredAt: now(),
    });
    return { success: true, decrementedQuantity: decrement };
  },
});

export const updateDynamicPrice = mutation({
  args: {
    inventoryId: v.id("inventory"),
    dynamicPrice: v.number(),
    isSurgeActive: v.boolean(),
    flashSaleReservedQty: v.optional(v.number()),
    membershipExclusiveQty: v.optional(v.number()),
    discountStartAt: v.optional(v.number()),
    discountEndAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.dynamicPrice < 0) throw new Error("dynamicPrice must be >= 0");
    const existing = await ctx.db
      .query("inventoryPricing")
      .withIndex("by_inventory", (q) => q.eq("inventoryId", args.inventoryId))
      .first();
    const payload = {
      inventoryId: args.inventoryId,
      dynamicPrice: args.dynamicPrice,
      flashSaleReservedQty: args.flashSaleReservedQty ?? 0,
      membershipExclusiveQty: args.membershipExclusiveQty ?? 0,
      discountStartAt: args.discountStartAt,
      discountEndAt: args.discountEndAt,
      isSurgeActive: args.isSurgeActive,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert("inventoryPricing", payload);
  },
});

export const replenishStock = mutation({
  args: {
    inventoryId: v.id("inventory"),
    quantity: v.number(),
  },
  handler: async (ctx, args) => {
    assertPositiveQuantity(args.quantity);
    const row = requireQuickInventory(
      (await ctx.db.get(args.inventoryId)) as QuickInventoryDoc | null,
    );
    await ctx.db.patch(args.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity! + args.quantity,
        row.reservedQuantity!,
        row.replenishmentThreshold!,
      ),
      expectedReplenishmentAt: undefined,
    });
    return { availableQuantity: row.availableQuantity! + args.quantity };
  },
});

export const expireCartReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const t = now();
    const expired = (await ctx.db
      .query("cartReservations")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", t))
      .collect()) as CartReservationDoc[];
    let count = 0;
    for (const reservation of expired) {
      if (reservation.status !== "active") continue;
      const row = requireQuickInventory(
        (await ctx.db.get(reservation.inventoryId)) as QuickInventoryDoc | null,
      );
      await ctx.db.patch(reservation.inventoryId, {
        ...quickInventoryPatch(
          row.availableQuantity!,
          Math.max(row.reservedQuantity! - reservation.quantity, 0),
          row.replenishmentThreshold!,
        ),
      });
      await ctx.db.patch(reservation._id, { status: "expired" });
      count += 1;
    }
    return { expired: count };
  },
});

export const updateShelfLife = internalMutation({
  args: {},
  handler: async (ctx) => {
    const t = now();
    const batches = (await ctx.db.query("batches").collect()) as BatchDoc[];
    for (const batch of batches) {
      if (batch.expiredAt !== undefined) continue;
      const daysRemaining = shelfLifeDaysRemaining(batch.expiryDate, t);
      await ctx.db.patch(batch._id, {
        shelfLifeDaysRemaining: daysRemaining,
        isNearExpiry: daysRemaining <= 2,
        pickPriority: pickPriorityScore(batch.expiryDate),
      });
    }
    return { updated: batches.length };
  },
});

export const flagNearExpiry = internalMutation({
  args: {},
  handler: async (ctx) => {
    const batches = (await ctx.db
      .query("batches")
      .withIndex("by_near_expiry", (q) => q.eq("isNearExpiry", true))
      .collect()) as BatchDoc[];
    let discounted = 0;
    for (const batch of batches) {
      if (batch.discountPercent > 0 || batch.expiredAt !== undefined) continue;
      await ctx.db.patch(batch._id, { discountPercent: 20 });
      discounted += 1;
    }
    return { discounted };
  },
});

export const replenishmentAlert = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("inventory").collect()) as QuickInventoryDoc[];
    let alerts = 0;
    for (const row of rows) {
      if (
        row.availableQuantity === undefined ||
        row.reservedQuantity === undefined ||
        row.replenishmentThreshold === undefined
      ) {
        continue;
      }
      const sellable = computeSellable(row.availableQuantity, row.reservedQuantity);
      const low = isLowStock(sellable, row.replenishmentThreshold);
      if (low) alerts += 1;
      if (row.isLowStock !== low) {
        await ctx.db.patch(row._id, {
          isLowStock: low,
          lastUpdatedAt: now(),
        });
      }
    }
    return { lowStockRows: alerts };
  },
});
