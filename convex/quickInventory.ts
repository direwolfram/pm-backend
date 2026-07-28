import { v } from "convex/values";
import { anyApi } from "convex/server";
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
type QuickStatus = "in_stock" | "low_stock" | "out_of_stock" | "unavailable";

const QUICK_INVENTORY_SUMMARY_VERSION = 1;
const SHELF_LIFE_BATCH_LIMIT = 100;

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
  isQuickInventory?: boolean;
  quickStatus?: QuickStatus;
  productName?: string;
  productBrand?: string;
  fulfillmentCenterName?: string;
  pricingSummary?: InventoryPricingDoc;
  batchCount?: number;
  nearExpiryBatchCount?: number;
  earliestExpiryDate?: number;
  quickInventorySummaryVersion?: number;
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
  nextShelfLifeRefreshAt?: number;
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
  _creationTime?: number;
  inventoryId: InventoryId;
  dynamicPrice: number;
  flashSaleReservedQty: number;
  membershipExclusiveQty: number;
  discountStartAt?: number;
  discountEndAt?: number;
  isSurgeActive: boolean;
}

interface ListByCenterArgs {
  fulfillmentCenterId?: CenterId;
  status?: QuickStatus;
  search?: string;
  limit?: number;
}

interface IndexRangeBuilder {
  eq(fieldName: string, value: unknown): IndexRangeBuilder;
}

interface QueryBuilder<T> {
  withIndex(
    indexName: string,
    indexRange?: (q: IndexRangeBuilder) => IndexRangeBuilder,
  ): QueryBuilder<T>;
  collect(): Promise<T[]>;
  first(): Promise<T | null>;
  take(n: number): Promise<T[]>;
}

interface DbReader {
  get(id: string): Promise<unknown | null>;
  query<T = unknown>(tableName: string): QueryBuilder<T>;
}

const qualityCheckStatus = v.union(
  v.literal("pending"),
  v.literal("passed"),
  v.literal("failed"),
);

function now(): number {
  return Date.now();
}

function nextManilaMidnightAfter(t: number) {
  const manilaOffset = 8 * 60 * 60 * 1000;
  const day = 86_400_000;
  return (Math.floor((t + manilaOffset) / day) + 1) * day - manilaOffset;
}

function nextShelfLifeRefreshAt(_expiryDate: number, evaluatedAt: number) {
  return nextManilaMidnightAfter(evaluatedAt);
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

function stockStatus(row: QuickInventoryDoc): QuickStatus {
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
  isActive?: boolean,
) {
  const sellable = computeSellable(availableQuantity, reservedQuantity);
  const low = isLowStock(sellable, replenishmentThreshold);
  const quickStatus: QuickStatus =
    isActive === false
      ? "unavailable"
      : sellable <= 0
        ? "out_of_stock"
        : low
          ? "low_stock"
          : "in_stock";
  return {
    availableQuantity,
    reservedQuantity,
    isLowStock: low,
    quickStatus,
    isQuickInventory: true,
    lastUpdatedAt: now(),
  };
}

function quickInventoryLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 300, 1), 500);
}

function isQuickInventoryRow(row: QuickInventoryDoc): boolean {
  return !!(row.sku && row.productId && row.fulfillmentCenterId);
}

function rowSearchText(
  row: QuickInventoryDoc,
  product?: ProductDoc | null,
  center?: FulfillmentCenterDoc | null,
): string {
  return `${row.sku ?? ""} ${row.productName ?? product?.name ?? ""} ${row.productBrand ?? product?.brand ?? ""} ${row.fulfillmentCenterName ?? center?.name ?? ""}`.toLowerCase();
}

function rowSortName(row: QuickInventoryDoc, product?: ProductDoc | null): string {
  return row.productName ?? product?.name ?? row.sku ?? "";
}

function productForRow(row: QuickInventoryDoc, product?: ProductDoc | null) {
  if (product) return product;
  if (row.productName === undefined) return null;
  return {
    _id: row.productId!,
    sku: row.sku,
    name: row.productName,
    brand: row.productBrand,
  };
}

function centerForRow(
  row: QuickInventoryDoc,
  center?: FulfillmentCenterDoc | null,
) {
  if (center) return center;
  if (row.fulfillmentCenterName === undefined) return null;
  return {
    _id: row.fulfillmentCenterId!,
    name: row.fulfillmentCenterName,
  };
}

async function fetchProductsById(
  ctx: { db: DbReader },
  productIds: ProductId[],
): Promise<Map<ProductId, ProductDoc | null>> {
  const products = new Map<ProductId, ProductDoc | null>();
  await Promise.all(
    Array.from(new Set(productIds)).map(async (productId) => {
      products.set(productId, (await ctx.db.get(productId)) as ProductDoc | null);
    }),
  );
  return products;
}

async function fetchCentersById(
  ctx: { db: DbReader },
  centerIds: CenterId[],
): Promise<Map<CenterId, FulfillmentCenterDoc | null>> {
  const centers = new Map<CenterId, FulfillmentCenterDoc | null>();
  await Promise.all(
    Array.from(new Set(centerIds)).map(async (centerId) => {
      centers.set(
        centerId,
        (await ctx.db.get(centerId)) as FulfillmentCenterDoc | null,
      );
    }),
  );
  return centers;
}

function batchSummaryFromBatches(batches: BatchDoc[]) {
  const sorted = [...batches].sort((a, b) => a.expiryDate - b.expiryDate);
  return {
    batchCount: sorted.length,
    nearExpiryBatchCount: sorted.filter((batch) => batch.isNearExpiry).length,
    earliestExpiryDate: sorted[0]?.expiryDate,
  };
}

function pricingSummaryFromDoc(pricing: InventoryPricingDoc | null) {
  if (!pricing) return undefined;
  return {
    _id: pricing._id,
    _creationTime: pricing._creationTime,
    inventoryId: pricing.inventoryId,
    dynamicPrice: pricing.dynamicPrice,
    flashSaleReservedQty: pricing.flashSaleReservedQty,
    membershipExclusiveQty: pricing.membershipExclusiveQty,
    discountStartAt: pricing.discountStartAt,
    discountEndAt: pricing.discountEndAt,
    isSurgeActive: pricing.isSurgeActive,
  };
}

async function computeBatchSummary(ctx: { db: DbReader }, inventoryId: InventoryId) {
  const batches = (await ctx.db
    .query<BatchDoc>("batches")
    .withIndex("by_inventory_expiry", (q) => q.eq("inventoryId", inventoryId))
    .collect()) as BatchDoc[];
  return batchSummaryFromBatches(batches);
}

async function computePricingSummary(
  ctx: { db: DbReader },
  inventoryId: InventoryId,
) {
  const pricing = (await ctx.db
    .query<InventoryPricingDoc>("inventoryPricing")
    .withIndex("by_inventory", (q) => q.eq("inventoryId", inventoryId))
    .first()) as InventoryPricingDoc | null;
  return pricingSummaryFromDoc(pricing);
}

async function patchInventorySummaries(
  ctx: { db: DbReader & { patch(id: string, patch: Record<string, unknown>): Promise<void> } },
  row: QuickInventoryDoc,
) {
  if (!isQuickInventoryRow(row)) {
    await ctx.db.patch(row._id, {
      quickInventorySummaryVersion: QUICK_INVENTORY_SUMMARY_VERSION,
    });
    return;
  }
  const [product, center, pricingSummary, batchSummary] = await Promise.all([
    ctx.db.get(row.productId!) as Promise<ProductDoc | null>,
    ctx.db.get(row.fulfillmentCenterId!) as Promise<FulfillmentCenterDoc | null>,
    computePricingSummary(ctx, row._id),
    computeBatchSummary(ctx, row._id),
  ]);
  await ctx.db.patch(row._id, {
    isQuickInventory: true,
    quickStatus: stockStatus(row),
    productName: product?.name ?? row.productName,
    productBrand: product?.brand ?? row.productBrand,
    fulfillmentCenterName: center?.name ?? row.fulfillmentCenterName,
    pricingSummary: pricingSummary ?? undefined,
    ...batchSummary,
    quickInventorySummaryVersion: QUICK_INVENTORY_SUMMARY_VERSION,
  });
}

export async function listByCenterHandler(
  ctx: { db: DbReader },
  args: ListByCenterArgs,
) {
  const limit = quickInventoryLimit(args.limit);
  const rawRows = args.fulfillmentCenterId
    ? args.status
      ? ((await ctx.db
          .query<QuickInventoryDoc>("inventory")
          .withIndex("by_center_quick_status", (q) =>
            q
              .eq("fulfillmentCenterId", args.fulfillmentCenterId!)
              .eq("quickStatus", args.status!),
          )
          .collect()) as QuickInventoryDoc[])
      : ((await ctx.db
          .query<QuickInventoryDoc>("inventory")
          .withIndex("by_center_active", (q) =>
            q.eq("fulfillmentCenterId", args.fulfillmentCenterId!),
          )
          .collect()) as QuickInventoryDoc[])
    : args.status
      ? ((await ctx.db
          .query<QuickInventoryDoc>("inventory")
          .withIndex("by_quick_status", (q) =>
            q.eq("quickStatus", args.status!),
          )
          .collect()) as QuickInventoryDoc[])
      : ((await ctx.db
          .query<QuickInventoryDoc>("inventory")
          .withIndex("by_quick_inventory", (q) =>
            q.eq("isQuickInventory", true),
          )
          .collect()) as QuickInventoryDoc[]);
  let rows = rawRows.filter(isQuickInventoryRow);
  if (args.status) {
    rows = rows.filter((row) => (row.quickStatus ?? stockStatus(row)) === args.status);
  }

  const productLookup = new Map<ProductId, ProductDoc | null>();
  const centerLookup = new Map<CenterId, FulfillmentCenterDoc | null>();

  if (args.search) {
    const search = args.search.toLowerCase();
    rows = rows.filter((row) =>
      rowSearchText(
        row,
        productLookup.get(row.productId!),
        centerLookup.get(row.fulfillmentCenterId!),
      ).includes(search),
    );
  }

  rows.sort((a, b) => {
    const aStatus = stockStatus(a);
    const bStatus = stockStatus(b);
    if (aStatus !== bStatus) return aStatus.localeCompare(bStatus);
    return rowSortName(a, productLookup.get(a.productId!)).localeCompare(
      rowSortName(b, productLookup.get(b.productId!)),
    );
  });

  const pageRows = rows.slice(0, limit);
  const missingPageProducts = pageRows.filter(
    (row) => row.productName === undefined && !productLookup.has(row.productId!),
  );
  const missingPageCenters = pageRows.filter(
    (row) =>
      row.fulfillmentCenterName === undefined &&
      !centerLookup.has(row.fulfillmentCenterId!),
  );
  const [pageProducts, pageCenters] = await Promise.all([
    fetchProductsById(
      ctx,
      missingPageProducts.map((row) => row.productId!),
    ),
    fetchCentersById(
      ctx,
      missingPageCenters.map((row) => row.fulfillmentCenterId!),
    ),
  ]);
  for (const [id, product] of pageProducts) productLookup.set(id, product);
  for (const [id, center] of pageCenters) centerLookup.set(id, center);

  return pageRows.map((row) => {
    const computed = withComputed(row);
    return {
      ...computed,
      status: row.quickStatus ?? stockStatus(row),
      product: productForRow(row, productLookup.get(row.productId!)),
      fulfillmentCenter: centerForRow(
        row,
        centerLookup.get(row.fulfillmentCenterId!),
      ),
      pricing: row.pricingSummary ?? null,
      batchCount: row.batchCount ?? 0,
      nearExpiryBatchCount: row.nearExpiryBatchCount ?? 0,
      earliestExpiryDate: row.earliestExpiryDate,
    };
  });
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
    return listByCenterHandler(ctx, args);
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
        row.isActive,
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
        row.isActive,
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
        row.isActive,
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
      ...quickInventoryPatch(
        nextAvailable,
        row.reservedQuantity!,
        row.replenishmentThreshold!,
        row.isActive,
      ),
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
      nextShelfLifeRefreshAt: nextShelfLifeRefreshAt(args.expiryDate, t),
    });
    await ctx.db.patch(args.inventoryId, {
      ...quickInventoryPatch(
        row.availableQuantity! + args.quantity,
        row.reservedQuantity!,
        row.replenishmentThreshold!,
        row.isActive,
      ),
      batchCount: (row.batchCount ?? 0) + 1,
      nearExpiryBatchCount:
        (row.nearExpiryBatchCount ?? 0) + (daysRemaining <= 2 ? 1 : 0),
      earliestExpiryDate:
        row.earliestExpiryDate === undefined
          ? args.expiryDate
          : Math.min(row.earliestExpiryDate, args.expiryDate),
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
        row.isActive,
      ),
    });
    await ctx.db.patch(args.batchId, {
      quantity: 0,
      qualityCheckStatus: "failed",
      expiredAt: now(),
    });
    await ctx.db.patch(batch.inventoryId, await computeBatchSummary(ctx, batch.inventoryId));
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
      await ctx.db.patch(args.inventoryId, {
        pricingSummary: {
          ...payload,
          _id: existing._id,
          _creationTime: (existing as InventoryPricingDoc)._creationTime,
        },
      });
      return existing._id;
    }
    const id = await ctx.db.insert("inventoryPricing", payload);
    const inserted = (await ctx.db.get(id)) as InventoryPricingDoc | null;
    await ctx.db.patch(args.inventoryId, {
      pricingSummary: pricingSummaryFromDoc(inserted),
    });
    return id;
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
        row.isActive,
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
          row.isActive,
        ),
      });
      await ctx.db.patch(reservation._id, { status: "expired" });
      count += 1;
    }
    return { expired: count };
  },
});

export const updateShelfLife = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    evaluatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const t = args.evaluatedAt ?? now();
    const limit = Math.min(
      Math.max(args.limit ?? SHELF_LIFE_BATCH_LIMIT, 1),
      SHELF_LIFE_BATCH_LIMIT,
    );
    const result = await ctx.db
      .query("batches")
      .withIndex("by_unexpired_shelf_life_due", (q) =>
        q.eq("expiredAt", undefined).lte("nextShelfLifeRefreshAt", t),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const page = result.page as BatchDoc[];
    const touchedInventoryIds = new Set<InventoryId>();
    let patched = 0;
    for (const batch of page) {
      if (batch.expiredAt !== undefined) {
        await ctx.db.patch(batch._id, {
          nextShelfLifeRefreshAt: undefined,
        });
        patched += 1;
        continue;
      }
      const daysRemaining = shelfLifeDaysRemaining(batch.expiryDate, t);
      const next = {
        shelfLifeDaysRemaining: daysRemaining,
        isNearExpiry: daysRemaining <= 2,
        pickPriority: pickPriorityScore(batch.expiryDate),
        nextShelfLifeRefreshAt: nextShelfLifeRefreshAt(batch.expiryDate, t),
      };
      if (
        batch.shelfLifeDaysRemaining !== next.shelfLifeDaysRemaining ||
        batch.isNearExpiry !== next.isNearExpiry ||
        batch.pickPriority !== next.pickPriority ||
        batch.nextShelfLifeRefreshAt !== next.nextShelfLifeRefreshAt
      ) {
        await ctx.db.patch(batch._id, next);
        touchedInventoryIds.add(batch.inventoryId);
        patched += 1;
      }
    }
    for (const inventoryId of touchedInventoryIds) {
      await ctx.db.patch(inventoryId, await computeBatchSummary(ctx, inventoryId));
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.quickInventory.updateShelfLife, {
        cursor: result.continueCursor,
        limit,
        evaluatedAt: t,
      });
    }
    return {
      processed: page.length,
      patched,
      touchedInventory: touchedInventoryIds.size,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
      timezone: "Asia/Manila",
    };
  },
});

export const backfillShelfLifeRefreshMarkers = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const t = now();
    const limit = Math.min(
      Math.max(args.limit ?? SHELF_LIFE_BATCH_LIMIT, 1),
      SHELF_LIFE_BATCH_LIMIT,
    );
    const result = await ctx.db
      .query("batches")
      .withIndex("by_expiry")
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let patched = 0;
    for (const batch of result.page as BatchDoc[]) {
      const marker =
        batch.expiredAt === undefined
          ? nextShelfLifeRefreshAt(batch.expiryDate, t)
          : undefined;
      if (batch.nextShelfLifeRefreshAt !== marker) {
        await ctx.db.patch(batch._id, { nextShelfLifeRefreshAt: marker });
        patched += 1;
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        anyApi.quickInventory.backfillShelfLifeRefreshMarkers,
        { limit, cursor: result.continueCursor },
      );
    }
    return {
      processed: result.page.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
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

export const backfillInventorySummaries = mutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const candidateLimit = args.cursor ? Math.min(limit * 2, 400) : limit;
    const candidates = (await ctx.db
      .query("inventory")
      .withIndex("by_summary_version", (q) =>
        q.eq("quickInventorySummaryVersion", undefined),
      )
      .take(candidateLimit)) as QuickInventoryDoc[];
    const cursorIndex = args.cursor
      ? candidates.findIndex((row) => row._id === args.cursor)
      : -1;
    const rows = candidates
      .slice(cursorIndex >= 0 ? cursorIndex + 1 : 0)
      .slice(0, limit);
    for (const row of rows) {
      await patchInventorySummaries(ctx, row);
    }
    return {
      processed: rows.length,
      nextCursor: rows.at(-1)?._id,
      remainingMayExist: candidates.length >= candidateLimit,
    };
  },
});
