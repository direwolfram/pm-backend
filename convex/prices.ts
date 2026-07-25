import { v } from "convex/values";
import { query, mutation } from "./functions";
import { assertPricePair, now } from "./helpers";
import type { PriceDoc } from "./model";

export const listBySku = query({
  args: { sku_id: v.id("skus") },
  handler: async (ctx, args) => {
    const prices = (await ctx.db
      .query("prices")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.sku_id))
      .collect()) as PriceDoc[];
    const withStore = [];
    for (const p of prices) {
      const store = p.store_id ? await ctx.db.get(p.store_id as any) : null;
      withStore.push({
        ...p,
        store_name: (store as { name?: string } | null)?.name ?? "All stores (base)",
        is_current:
          p.starts_at <= Date.now() && (!p.ends_at || p.ends_at > Date.now()),
      });
    }
    withStore.sort((a, b) => b.starts_at - a.starts_at);
    return withStore;
  },
});

export const upsert = mutation({
  args: {
    id: v.optional(v.id("prices")),
    sku_id: v.id("skus"),
    store_id: v.optional(v.id("stores")),
    currency: v.optional(v.string()),
    sale_price: v.number(),
    compare_at_price: v.optional(v.number()),
    starts_at: v.optional(v.number()),
    ends_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertPricePair(args.sale_price, args.compare_at_price);
    if (
      args.ends_at !== undefined &&
      args.starts_at !== undefined &&
      args.ends_at <= args.starts_at
    ) {
      throw new Error("ends_at must be after starts_at");
    }
    const sku = await ctx.db.get(args.sku_id);
    if (!sku) throw new Error("SKU not found");
    if (args.id) {
      const existing = (await ctx.db.get(args.id)) as PriceDoc | null;
      if (!existing) throw new Error("Price not found");
      const startsAt = args.starts_at ?? existing.starts_at;
      if (args.ends_at !== undefined && args.ends_at <= startsAt) {
        throw new Error("ends_at must be after starts_at");
      }
      await ctx.db.patch(args.id, {
        store_id: args.store_id,
        currency: args.currency ?? existing.currency,
        sale_price: args.sale_price,
        compare_at_price: args.compare_at_price,
        starts_at: args.starts_at ?? existing.starts_at,
        ends_at: args.ends_at,
      });
      return args.id;
    }
    return await ctx.db.insert("prices", {
      sku_id: args.sku_id,
      store_id: args.store_id,
      currency: args.currency ?? "PHP",
      sale_price: args.sale_price,
      compare_at_price: args.compare_at_price,
      starts_at: args.starts_at ?? now(),
      ends_at: args.ends_at,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("prices") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
