import { v } from "convex/values";
import { query, mutation } from "./functions";
import type { InventoryDoc, PriceDoc, SkuDoc } from "./model";

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

export const listByProduct = query({
  args: { product_id: v.id("products") },
  handler: async (ctx, args) => {
    const skus = (await ctx.db
      .query("skus")
      .withIndex("by_product", (q) => q.eq("product_id", args.product_id))
      .collect()) as SkuDoc[];
    skus.sort((a, b) => a.sort_order - b.sort_order);
    const result = [];
    for (const s of skus) {
      const prices = (await ctx.db
        .query("prices")
        .withIndex("by_sku", (q) => q.eq("sku_id", s._id))
        .collect()) as PriceDoc[];
      const inventory = (await ctx.db
        .query("inventory")
        .withIndex("by_sku", (q) => q.eq("sku_id", s._id))
        .collect()) as InventoryDoc[];
      result.push({ ...s, prices, inventory });
    }
    return result;
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

/** Keep exactly one default SKU per product. */
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

export const create = mutation({
  args: skuFields,
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.product_id);
    if (!product) throw new Error("Product not found");
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
    if (args.is_default) {
      await unsetOtherDefaults(ctx, args.product_id, id as string);
    }
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
    if (patch.sku_code || patch.barcode) {
      await assertUniqueSkuCode(
        ctx,
        patch.sku_code ?? sku.sku_code,
        patch.barcode,
        id as string,
      );
    }
    await ctx.db.patch(id, patch);
    if (patch.is_default) {
      await unsetOtherDefaults(ctx, sku.product_id, id as string);
    }
    return id;
  },
});

/** SQL cascade: prices and inventory rows go with the SKU. */
export const remove = mutation({
  args: { id: v.id("skus") },
  handler: async (ctx, args) => {
    const sku = (await ctx.db.get(args.id)) as SkuDoc | null;
    if (!sku) throw new Error("SKU not found");
    const orderItem = await ctx.db
      .query("order_items")
      .collect()
      .then((rows) => rows.find((r) => r.sku_id === args.id));
    if (orderItem) {
      throw new Error(
        "Cannot delete: this SKU appears in orders. Deactivate it instead.",
      );
    }
    const prices = await ctx.db
      .query("prices")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .collect();
    for (const p of prices) await ctx.db.delete(p._id);
    const inv = await ctx.db
      .query("inventory")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.id))
      .collect();
    for (const i of inv) await ctx.db.delete(i._id);
    await ctx.db.delete(args.id);
    // ensure a remaining SKU becomes default if we deleted the default
    if (sku.is_default) {
      const remaining = (await ctx.db
        .query("skus")
        .withIndex("by_product", (q) => q.eq("product_id", sku.product_id))
        .collect()) as SkuDoc[];
      if (remaining.length > 0) {
        await ctx.db.patch(remaining[0]._id as any, { is_default: true });
      }
    }
  },
});
