import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { now, paginate } from "./helpers";
import {
  decrementProductStock,
  refreshProductDefaultPrice,
} from "./lib/productListSummaries";
import { applyListCountChange, inventoryCountKeys } from "./listCounts";
import { deletePriceCascade } from "./prices";
import type { DeliveryZoneDoc, InventoryDoc, PriceDoc, StoreDoc } from "./model";

const CASCADE_BATCH_LIMIT = 100;

export const list = query({
  args: {
    includeInactive: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("stores").collect()) as StoreDoc[];
    if (!args.includeInactive) rows = rows.filter((s) => s.status === "active");
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const zones = (await ctx.db.query("delivery_zones").collect()) as DeliveryZoneDoc[];
    const enriched = rows.map((s) => ({
      ...s,
      zone_count: zones.filter((z) => z.store_id === s._id).length,
    }));
    return paginate(enriched, args);
  },
});

export const get = query({
  args: { id: v.id("stores") },
  handler: async (ctx, args) => {
    const store = (await ctx.db.get(args.id)) as StoreDoc | null;
    if (!store) throw new Error("Store not found");
    const zones = (await ctx.db
      .query("delivery_zones")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .collect()) as DeliveryZoneDoc[];
    return { ...store, zones };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("inactive"))),
    address: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("stores", {
      name: args.name,
      status: args.status ?? "active",
      address: args.address,
      latitude: args.latitude,
      longitude: args.longitude,
      timezone: args.timezone ?? "Asia/Manila",
      created_at: now(),
      updated_at: now(),
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("stores"),
    name: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("inactive"))),
    address: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const store = await ctx.db.get(id);
    if (!store) throw new Error("Store not found");
    await ctx.db.patch(id, { ...patch, updated_at: now() });
    if (patch.name) {
      const [prices, inventory] = await Promise.all([
        ctx.db
          .query("prices")
          .withIndex("by_store", (q) => q.eq("store_id", id))
          .collect(),
        ctx.db
          .query("inventory")
          .withIndex("by_store", (q) => q.eq("store_id", id))
          .collect(),
      ]);
      for (const price of prices) {
        await ctx.db.patch(price._id, {
          storeName: patch.name,
          priceSummaryVersion: 1,
        });
      }
      for (const row of inventory) {
        await ctx.db.patch(row._id, {
          storeName: patch.name,
          storeInventorySummaryVersion: 1,
        });
      }
    }
    return id;
  },
});

/**
 * Cascade: delivery zones, inventory, and prices go with the store; orders
 * restrict. Bounded, resumable internal continuation.
 */
export const remove = mutation({
  args: { id: v.id("stores") },
  handler: async (ctx, args) => {
    const store = (await ctx.db.get(args.id)) as StoreDoc | null;
    if (!store) return { id: args.id, deleting: true };
    const order = await ctx.db
      .query("orders")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .first();
    if (order) throw new Error("Cannot delete a store that has orders");
    if (!store.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.stores.continueStoreDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continueStoreDelete = internalMutation({
  args: { id: v.id("stores") },
  handler: async (ctx, args) => {
    const store = (await ctx.db.get(args.id)) as StoreDoc | null;
    if (!store) return { done: true, deleted: true };
    const order = await ctx.db
      .query("orders")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .first();
    if (order) throw new Error("Cannot delete a store that has orders");
    let operations = 0;
    const zones = await ctx.db
      .query("delivery_zones")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const z of zones) {
      await ctx.db.delete(z._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.stores.continueStoreDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const inv = (await ctx.db
      .query("inventory")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations)) as InventoryDoc[];
    const deletedStockByProduct = new Map<string, number>();
    for (const row of inv) {
      await ctx.db.delete(row._id);
      await applyListCountChange(ctx, "inventory", inventoryCountKeys, row, null);
      const productId = row.productId;
      if (productId) {
        const quantity =
          row.quantity_available ??
          (row as InventoryDoc & { availableQuantity?: number })
            .availableQuantity ??
          0;
        deletedStockByProduct.set(
          productId,
          (deletedStockByProduct.get(productId) ?? 0) + quantity,
        );
      }
      operations += 1;
    }
    // Keep product total_stock exact as inventory disappears.
    for (const [productId, quantity] of deletedStockByProduct) {
      await decrementProductStock(ctx, productId, quantity);
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.stores.continueStoreDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const prices = (await ctx.db
      .query("prices")
      .withIndex("by_store", (q) => q.eq("store_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations)) as PriceDoc[];
    const priceProducts = new Set<string>();
    for (const p of prices) {
      // Invariant-preserving deletion: only this price's own mirror goes
      // with it; base and other-store mirrors of the same SKU survive.
      await deletePriceCascade(ctx, p);
      if (p.product_id) priceProducts.add(p.product_id);
      operations += 1;
    }
    // Reconcile default_price only after the batch's surviving mirrors are
    // correct (idempotent across batch continuations).
    for (const productId of priceProducts) {
      await refreshProductDefaultPrice(ctx, productId);
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.stores.continueStoreDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await ctx.db.delete(args.id);
    return { done: true, operations };
  },
});

// ---- Delivery zones ----

const zoneFields = {
  store_id: v.id("stores"),
  name: v.string(),
  delivery_mode: v.union(
    v.literal("express"),
    v.literal("savers"),
    v.literal("sari-sari"),
  ),
  min_order_amount: v.optional(v.number()),
  delivery_fee_amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  estimated_minutes_min: v.number(),
  estimated_minutes_max: v.number(),
  is_active: v.optional(v.boolean()),
};

export const createZone = mutation({
  args: zoneFields,
  handler: async (ctx, args) => {
    if (args.estimated_minutes_max < args.estimated_minutes_min) {
      throw new Error("Max ETA must be >= min ETA");
    }
    const store = await ctx.db.get(args.store_id);
    if (!store) throw new Error("Store not found");
    if ((store as { deleting_at?: number }).deleting_at) {
      throw new Error("Store is being deleted");
    }
    return await ctx.db.insert("delivery_zones", {
      store_id: args.store_id,
      name: args.name,
      delivery_mode: args.delivery_mode,
      min_order_amount: args.min_order_amount ?? 0,
      delivery_fee_amount: args.delivery_fee_amount ?? 0,
      currency: args.currency ?? "PHP",
      estimated_minutes_min: args.estimated_minutes_min,
      estimated_minutes_max: args.estimated_minutes_max,
      is_active: args.is_active ?? true,
    });
  },
});

export const updateZone = mutation({
  args: {
    id: v.id("delivery_zones"),
    name: v.optional(v.string()),
    delivery_mode: v.optional(
      v.union(v.literal("express"), v.literal("savers"), v.literal("sari-sari")),
    ),
    min_order_amount: v.optional(v.number()),
    delivery_fee_amount: v.optional(v.number()),
    estimated_minutes_min: v.optional(v.number()),
    estimated_minutes_max: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const zone = await ctx.db.get(id);
    if (!zone) throw new Error("Zone not found");
    await ctx.db.patch(id, patch);
    return id;
  },
});

export const removeZone = mutation({
  args: { id: v.id("delivery_zones") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
