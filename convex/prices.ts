import { v } from "convex/values";
import { query, mutation } from "./functions";
import { assertPricePair, now } from "./helpers";
import { recomputeProductListSummary } from "./lib/productListSummaries";
import type { PriceDoc } from "./model";

const PRICE_SUMMARY_VERSION = 1;

export async function listBySkuHandler(
  ctx: { db: any },
  args: { sku_id: string },
) {
    const resultLimit = 500;
    const prices = (await ctx.db
      .query("prices")
      .withIndex("by_sku", (q) => q.eq("sku_id", args.sku_id))
      .take(resultLimit)) as PriceDoc[];
    const missingStoreIds = Array.from(
      new Set(
        prices
          .filter((price) => price.store_id && price.storeName === undefined)
          .map((price) => price.store_id!),
      ),
    );
    const stores = new Map<string, { name?: string } | null>();
    await Promise.all(
      missingStoreIds.map(async (storeId) => {
        stores.set(
          storeId,
          (await ctx.db.get(storeId as any)) as { name?: string } | null,
        );
      }),
    );
    const withStore = prices.map((p) => {
      const storeName = p.store_id
        ? p.storeName ?? stores.get(p.store_id)?.name ?? "(deleted store)"
        : "All stores (base)";
      return {
        ...p,
        store_name: storeName,
        is_current:
          p.starts_at <= Date.now() && (!p.ends_at || p.ends_at > Date.now()),
      };
    });
    withStore.sort((a, b) => b.starts_at - a.starts_at);
    return withStore;
}

export const listBySku = query({
  args: { sku_id: v.id("skus") },
  handler: async (ctx, args) => {
    return await listBySkuHandler(ctx, args);
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
    const store = args.store_id
      ? ((await ctx.db.get(args.store_id)) as { name?: string } | null)
      : null;
    if (args.id) {
      const existing = (await ctx.db.get(args.id)) as PriceDoc | null;
      if (!existing) throw new Error("Price not found");
      const startsAt = args.starts_at ?? existing.starts_at;
      if (args.ends_at !== undefined && args.ends_at <= startsAt) {
        throw new Error("ends_at must be after starts_at");
      }
      await ctx.db.patch(args.id, {
        product_id: (sku as { product_id: string }).product_id,
        store_id: args.store_id,
        storeName: store?.name,
        currency: args.currency ?? existing.currency,
        sale_price: args.sale_price,
        compare_at_price: args.compare_at_price,
        starts_at: args.starts_at ?? existing.starts_at,
        ends_at: args.ends_at,
        priceSummaryVersion: PRICE_SUMMARY_VERSION,
      });
      await recomputeProductListSummary(
        ctx,
        (sku as { product_id: string }).product_id,
      );
      return args.id;
    }
    const id = await ctx.db.insert("prices", {
      sku_id: args.sku_id,
      product_id: (sku as { product_id: string }).product_id,
      store_id: args.store_id,
      storeName: store?.name,
      currency: args.currency ?? "PHP",
      sale_price: args.sale_price,
      compare_at_price: args.compare_at_price,
      starts_at: args.starts_at ?? now(),
      ends_at: args.ends_at,
      priceSummaryVersion: PRICE_SUMMARY_VERSION,
    });
    await recomputeProductListSummary(ctx, (sku as { product_id: string }).product_id);
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("prices") },
  handler: async (ctx, args) => {
    const price = (await ctx.db.get(args.id)) as PriceDoc | null;
    await ctx.db.delete(args.id);
    if (price?.product_id) {
      await recomputeProductListSummary(ctx, price.product_id);
    }
  },
});

export const backfillPriceSummaries = mutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const candidateLimit = args.cursor ? Math.min(limit * 2, 400) : limit;
    const candidates = (await ctx.db
      .query("prices")
      .withIndex("by_price_summary_version", (q: any) =>
        q.eq("priceSummaryVersion", undefined),
      )
      .take(candidateLimit)) as PriceDoc[];
    const cursorIndex = args.cursor
      ? candidates.findIndex((row) => row._id === args.cursor)
      : -1;
    const rows = candidates
      .slice(cursorIndex >= 0 ? cursorIndex + 1 : 0)
      .slice(0, limit);
    let patched = 0;
    for (const price of rows) {
      const sku = (await ctx.db.get(price.sku_id as any)) as
        | { product_id: string }
        | null;
      const store = price.store_id
        ? ((await ctx.db.get(price.store_id as any)) as { name?: string } | null)
        : null;
      const patch = {
        product_id: sku?.product_id,
        storeName: store?.name,
        priceSummaryVersion: PRICE_SUMMARY_VERSION,
      };
      if (price.product_id !== patch.product_id || price.storeName !== patch.storeName) {
        await ctx.db.patch(price._id as any, patch);
        patched += 1;
      }
    }
    return {
      processed: rows.length,
      patched,
      nextCursor: rows.at(-1)?._id,
      remainingMayExist: candidates.length >= candidateLimit,
    };
  },
});
