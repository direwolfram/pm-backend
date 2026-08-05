import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { now } from "./helpers";
import {
  deletePricesActiveForSku,
  recomputeProductListSummary,
} from "./lib/productListSummaries";
import { deletePriceCascade } from "./prices";
import { applyListCountChange, inventoryCountKeys, skuCountKeys } from "./listCounts";
import type { InventoryDoc, PriceDoc, SkuDoc } from "./model";

const CASCADE_BATCH_LIMIT = 100;

export const listAll = query({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const skus = (await ctx.db.query("skus").collect()) as SkuDoc[];
    const products = new Map(
      (await ctx.db.query("products").collect()).map((p) => [
        p._id as string,
        p.name as string,
      ]),
    );
    let rows = skus.map((s) => ({
      ...s,
      product_name: products.get(s.product_id) ?? "(deleted product)",
    }));
    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.product_name.toLowerCase().includes(q) ||
          r.sku_code.toLowerCase().includes(q) ||
          r.variant_label.toLowerCase().includes(q),
      );
    }
    rows.sort((a, b) => a.product_name.localeCompare(b.product_name));
    return rows.slice(0, 300);
  },
});

export async function listByProductHandler(
  ctx: { db: any },
  args: { product_id: string },
) {
    const [skus, prices, inventory] = (await Promise.all([
      ctx.db
        .query("skus")
        .withIndex("by_product", (q: any) => q.eq("product_id", args.product_id))
        .collect(),
      ctx.db
        .query("prices")
        .withIndex("by_product", (q: any) => q.eq("product_id", args.product_id))
        .collect(),
      ctx.db
        .query("inventory")
        .withIndex("by_product_id", (q: any) => q.eq("productId", args.product_id))
        .collect(),
    ])) as [SkuDoc[], PriceDoc[], InventoryDoc[]];
    skus.sort((a, b) => a.sort_order - b.sort_order);
    const pricesBySku = new Map<string, PriceDoc[]>();
    for (const price of prices) {
      const rows = pricesBySku.get(price.sku_id) ?? [];
      rows.push(price);
      pricesBySku.set(price.sku_id, rows);
    }
    const inventoryBySku = new Map<string, InventoryDoc[]>();
    for (const row of inventory) {
      if (row.sku_id === undefined) continue;
      const rows = inventoryBySku.get(row.sku_id) ?? [];
      rows.push(row);
      inventoryBySku.set(row.sku_id, rows);
    }
  return skus.map((s) => ({
      ...s,
      prices: pricesBySku.get(s._id) ?? [],
      inventory: inventoryBySku.get(s._id) ?? [],
    }));
}

export const listByProduct = query({
  args: { product_id: v.id("products") },
  handler: async (ctx, args) => {
    return await listByProductHandler(ctx, args);
  },
});

const skuFields = {
  product_id: v.id("products"),
  sku_code: v.string(),
  barcode: v.optional(v.string()),
  display_name: v.optional(v.string()),
  variant_label: v.string(),
  pack_size: v.optional(v.string()),
  unit_of_measure: v.optional(v.string()),
  shade_name: v.optional(v.string()),
  shade_color: v.optional(v.string()),
  image_color: v.optional(v.string()),
  badge_text: v.optional(v.string()),
  sort_order: v.optional(v.number()),
  is_default: v.optional(v.boolean()),
  is_active: v.optional(v.boolean()),
};

async function assertUniqueSkuCode(
  ctx: { db: any },
  skuCode: string,
  barcode?: string,
  excludeId?: string,
) {
  const dup = await ctx.db
    .query("skus")
    .withIndex("by_sku_code", (q: any) => q.eq("sku_code", skuCode))
    .first();
  if (dup && dup._id !== excludeId) {
    throw new Error(`SKU code "${skuCode}" is already used`);
  }
  if (barcode) {
    const dupB = await ctx.db
      .query("skus")
      .withIndex("by_barcode", (q: any) => q.eq("barcode", barcode))
      .first();
    if (dupB && dupB._id !== excludeId) {
      throw new Error(`Barcode "${barcode}" is already used`);
    }
  }
}

/** Invariant: every product with an active SKU has exactly one active default. */
async function unsetOtherDefaults(
  ctx: { db: any },
  productId: string,
  keepId: string,
) {
  const skus = await ctx.db
    .query("skus")
    .withIndex("by_product", (q: any) => q.eq("product_id", productId))
    .collect();
  for (const s of skus) {
    if (s._id !== keepId && s.is_default) {
      await ctx.db.patch(s._id, { is_default: false });
    }
  }
}


async function reconcileProductDefault(ctx: { db: any }, productId: string, preferredId?: string) {
  const skus = (await ctx.db.query("skus").withIndex("by_product", (q: any) => q.eq("product_id", productId)).collect()) as SkuDoc[];
  const active = skus.filter((sku) => sku.is_active && !sku.deleting_at);
  if (!active.length) {
    for (const sku of skus) if (sku.is_default) await ctx.db.patch(sku._id, { is_default: false });
    return;
  }
  const current = active.find((sku) => sku._id === preferredId) ?? active.find((sku) => sku.is_default) ?? active[0];
  for (const sku of skus) {
    const shouldDefault = sku._id === current._id;
    if (sku.is_default !== shouldDefault) await ctx.db.patch(sku._id, { is_default: shouldDefault });
  }
}
export const create = mutation({
  args: skuFields,
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.product_id);
    if (!product) throw new Error("Product not found");
    if ((product as { deleting_at?: number }).deleting_at) {
      throw new Error("Product is being deleted");
    }
    await assertUniqueSkuCode(ctx, args.sku_code, args.barcode);
    const id = await ctx.db.insert("skus", {
      product_id: args.product_id,
      sku_code: args.sku_code,
      barcode: args.barcode,
      display_name: args.display_name,
      variant_label: args.variant_label,
      pack_size: args.pack_size,
      unit_of_measure: args.unit_of_measure,
      shade_name: args.shade_name,
      shade_color: args.shade_color,
      image_color: args.image_color,
      badge_text: args.badge_text,
      sort_order: args.sort_order ?? 0,
      is_default: args.is_default ?? false,
      is_active: args.is_active ?? true,
    });
    await reconcileProductDefault(ctx, args.product_id, args.is_default && (args.is_active ?? true) ? id as string : undefined);
    await applyListCountChange(ctx, "skus", skuCountKeys, null, {});
    await recomputeProductListSummary(ctx, args.product_id);
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("skus"),
    product_id: v.optional(v.id("products")),
    sku_code: v.optional(v.string()),
    barcode: v.optional(v.string()),
    display_name: v.optional(v.string()),
    variant_label: v.optional(v.string()),
    pack_size: v.optional(v.string()),
    unit_of_measure: v.optional(v.string()),
    shade_name: v.optional(v.string()),
    shade_color: v.optional(v.string()),
    image_color: v.optional(v.string()),
    badge_text: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    is_default: v.optional(v.boolean()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const sku = (await ctx.db.get(id)) as SkuDoc | null;
    if (!sku) throw new Error("SKU not found");
    const nextProductId = patch.product_id ?? sku.product_id;
    const product = (await ctx.db.get(nextProductId as any)) as
      | { name?: string; deleting_at?: number }
      | null;
    if (!product) throw new Error("Product not found");
    if (product.deleting_at) throw new Error("Product is being deleted");
    if (patch.sku_code || patch.barcode) {
      await assertUniqueSkuCode(
        ctx,
        patch.sku_code ?? sku.sku_code,
        patch.barcode,
        id as string,
      );
    }
    await ctx.db.patch(id, patch);
    const prices = await ctx.db
      .query("prices")
      .withIndex("by_sku", (q) => q.eq("sku_id", id))
      .collect();
    for (const price of prices) {
      await ctx.db.patch(price._id, {
        product_id: nextProductId,
        priceSummaryVersion: 1,
      });
    }
    if (nextProductId !== sku.product_id) {
      // A SKU move must keep the active-price mirrors pointing at the new
      // product so transition drains recompute the right summaries.
      const mirrors = await ctx.db
        .query("pricesActive")
        .withIndex("by_sku", (q) => q.eq("sku_id", id))
        .collect();
      for (const mirror of mirrors) {
        if (mirror.product_id !== nextProductId) {
          await ctx.db.patch(mirror._id, { product_id: nextProductId });
        }
      }
    }
    const inventory = await ctx.db
      .query("inventory")
      .withIndex("by_sku", (q) => q.eq("sku_id", id))
      .collect();
    for (const row of inventory) {
      await ctx.db.patch(row._id, {
        productId: nextProductId,
        skuCode: patch.sku_code ?? sku.sku_code,
        variantLabel: patch.variant_label ?? sku.variant_label,
        productName: product.name,
        storeInventorySummaryVersion: 1,
      });
    }
    const effectiveActive = patch.is_active ?? sku.is_active;
    const preferredDestination = patch.is_default && effectiveActive ? id as string : undefined;
    if (preferredDestination) await unsetOtherDefaults(ctx, nextProductId, id as string);
    if (nextProductId !== sku.product_id) await reconcileProductDefault(ctx, sku.product_id);
    await reconcileProductDefault(ctx, nextProductId, preferredDestination);
    await recomputeProductListSummary(ctx, sku.product_id);
    if (nextProductId !== sku.product_id) {
      await recomputeProductListSummary(ctx, nextProductId);
    }
    return id;
  },
});

/**
 * SQL cascade: prices and inventory rows go with the SKU. Deletion is a
 * bounded, resumable workflow: the public mutation validates restrict rules
 * (order items), marks the SKU as deleting, and schedules internal cleanup
 * that drains prices and inventory in fixed-size batches before removing
 * the SKU root.
 */
export const remove = mutation({
  args: { id: v.id("skus") },
  handler: async (ctx, args) => {
    const sku = (await ctx.db.get(args.id)) as SkuDoc | null;
    if (!sku) return { id: args.id, deleting: true };
    const orderItem = await ctx.db
      .query("order_items")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .first();
    if (orderItem) {
      throw new Error(
        "Cannot delete: this SKU appears in orders. Deactivate it instead.",
      );
    }
    if (!sku.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.skus.continueSkuDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continueSkuDelete = internalMutation({
  args: { id: v.id("skus") },
  handler: async (ctx, args) => {
    const sku = (await ctx.db.get(args.id)) as SkuDoc | null;
    if (!sku) return { done: true, deleted: true };
    const orderItem = await ctx.db
      .query("order_items")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .first();
    if (orderItem) {
      throw new Error("Cannot delete: this SKU appears in orders");
    }
    let operations = 0;
    const prices = await ctx.db
      .query("prices")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const p of prices) {
      await deletePriceCascade(ctx, p);
      operations += 1;
    }
    // Mirror sweep: any pricesActive rows for this SKU left by prices deleted
    // in earlier (pre-helper) batches go with the SKU.
    await deletePricesActiveForSku(ctx, args.id);
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.skus.continueSkuDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const inv = await ctx.db
      .query("inventory")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const i of inv) {
      await ctx.db.delete(i._id);
      await applyListCountChange(ctx, "inventory", inventoryCountKeys, i as InventoryDoc, null);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.skus.continueSkuDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await ctx.db.delete(args.id);
    await applyListCountChange(ctx, "skus", skuCountKeys, {}, null);
    await reconcileProductDefault(ctx, sku.product_id);
    await recomputeProductListSummary(ctx, sku.product_id);
    return { done: true, operations };
  },
});
