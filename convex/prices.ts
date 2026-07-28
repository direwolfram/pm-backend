import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { assertPricePair, now } from "./helpers";
import {
  PRICE_ACTIVE_LOOKAHEAD_MS,
  priceIsActiveMaterializable,
  recomputeProductListSummary,
} from "./lib/productListSummaries";
import type { PriceDoc } from "./model";

const PRICE_SUMMARY_VERSION = 2;
const PRICE_TRANSITION_BATCH_LIMIT = 200;

/**
 * Persist the next-transition records for one price. A future starts_at gets
 * two journal rows: a materialization record at starts_at - lookahead (the
 * mirror must exist before the price can become time-active, so list reads
 * through pricesActive stay correct the moment it activates) and a refresh
 * record at starts_at itself (stored summaries must be recomputed at the
 * activation instant even though the mirror row does not change then).
 * Idempotent: existing rows for the price are reconciled to the desired set,
 * so edits move the activation and removals (via
 * deletePriceTransitionJournal) cancel it.
 */
async function journalPriceActivation(
  ctx: { db: any },
  price: PriceDoc,
  t: number,
) {
  const existing = (await ctx.db
    .query("priceTransitions")
    .withIndex("by_price", (q: any) => q.eq("price_id", price._id))
    .collect()) as { _id: string; due_at: number }[];
  const desired =
    price.starts_at > t
      ? [price.starts_at - PRICE_ACTIVE_LOOKAHEAD_MS, price.starts_at]
      : [];
  const keep = new Set(
    existing
      .filter((row) => desired.includes(row.due_at))
      .map((row) => row.due_at),
  );
  let changed = false;
  for (const row of existing) {
    if (!desired.includes(row.due_at)) {
      await ctx.db.delete(row._id);
      changed = true;
    }
  }
  for (const dueAt of desired) {
    if (keep.has(dueAt)) continue;
    await ctx.db.insert("priceTransitions", {
      price_id: price._id,
      due_at: dueAt,
    });
    changed = true;
  }
  return changed;
}

/** Remove every pending activation record for a deleted price. */
export async function deletePriceTransitionJournal(
  ctx: { db: any },
  priceId: string,
) {
  const rows = (await ctx.db
    .query("priceTransitions")
    .withIndex("by_price", (q: any) => q.eq("price_id", priceId))
    .collect()) as { _id: string }[];
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

/**
 * Keep the pricesActive mirror row for one price in sync. Returns true when
 * the mirror was inserted, patched, or deleted.
 */
async function syncPriceActiveRow(
  ctx: { db: any },
  price: PriceDoc,
  t: number,
) {
  const rows = (await ctx.db
    .query("pricesActive")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", price.sku_id))
    .collect()) as {
    _id: string;
    price_id: string;
    product_id?: string;
    store_id?: string;
    sale_price: number;
    starts_at: number;
    ends_at?: number;
  }[];
  const mirror = rows.find((row) => row.price_id === price._id);
  if (priceIsActiveMaterializable(price, t)) {
    const payload = {
      sku_id: price.sku_id,
      price_id: price._id,
      product_id: price.product_id,
      store_id: price.store_id,
      sale_price: price.sale_price,
      starts_at: price.starts_at,
      ends_at: price.ends_at,
    };
    if (mirror) {
      if (
        mirror.product_id !== payload.product_id ||
        mirror.store_id !== payload.store_id ||
        mirror.sale_price !== payload.sale_price ||
        mirror.starts_at !== payload.starts_at ||
        mirror.ends_at !== payload.ends_at
      ) {
        await ctx.db.patch(mirror._id, payload);
        return true;
      }
      return false;
    }
    await ctx.db.insert("pricesActive", payload);
    return true;
  }
  if (mirror) {
    await ctx.db.delete(mirror._id);
    return true;
  }
  return false;
}

async function removePriceActiveRow(ctx: { db: any }, price: PriceDoc) {
  const rows = (await ctx.db
    .query("pricesActive")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", price.sku_id))
    .collect()) as { _id: string; price_id: string }[];
  const mirror = rows.find((row) => row.price_id === price._id);
  if (mirror) await ctx.db.delete(mirror._id);
}

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
    if ((sku as { deleting_at?: number }).deleting_at) {
      throw new Error("SKU is being deleted");
    }
    const product = await ctx.db.get((sku as { product_id: string }).product_id);
    if ((product as { deleting_at?: number } | null)?.deleting_at) {
      throw new Error("Product is being deleted");
    }
    const store = args.store_id
      ? ((await ctx.db.get(args.store_id)) as {
          name?: string;
          deleting_at?: number;
        } | null)
      : null;
    if (args.store_id && !store) throw new Error("Store not found");
    if (store?.deleting_at) throw new Error("Store is being deleted");
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
      await syncPriceActiveRow(
        ctx,
        { ...existing, ...(await ctx.db.get(args.id)) } as PriceDoc,
        now(),
      );
      await journalPriceActivation(
        ctx,
        (await ctx.db.get(args.id)) as PriceDoc,
        now(),
      );
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
    const inserted = (await ctx.db.get(id)) as PriceDoc;
    await syncPriceActiveRow(ctx, inserted, now());
    await journalPriceActivation(ctx, inserted, now());
    await recomputeProductListSummary(ctx, (sku as { product_id: string }).product_id);
    return id;
  },
});

export const remove = mutation({
  args: { id: v.id("prices") },
  handler: async (ctx, args) => {
    const price = (await ctx.db.get(args.id)) as PriceDoc | null;
    await ctx.db.delete(args.id);
    if (price) {
      await removePriceActiveRow(ctx, price);
      await deletePriceTransitionJournal(ctx, args.id);
    }
    if (price?.product_id) {
      await recomputeProductListSummary(ctx, price.product_id);
    }
  },
});

/**
 * Complete bounded price-transition drain. Two indexed due-time phases per
 * execution; both self-schedule until drained:
 * A. Expirations: delete pricesActive mirror rows whose ends_at passed
 *    (indexed take on pricesActive.by_ends_at; destructive drain, re-queried
 *    each execution until empty).
 * B. Activations: drain the persisted priceTransitions journal
 *    (by_due <= now + lookahead). Every future price carries exactly one
 *    journal row written at upsert/backfill time, so prices created days or
 *    months before starts_at are materialized without rescanning price
 *    history, batches over 200 continue via self-scheduling, and concurrent
 *    cron runs are safe: each run deletes the journal rows it processed in
 *    the same transaction, and mirror sync is idempotent.
 * Only products whose active-price set actually changed get their summaries
 * recomputed.
 */
export const scheduleTransition = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const t = args.now ?? now();
    const touchedProducts = new Set<string>();

    // Phase A: expirations (destructive drain — no cursor needed).
    const expiredMirrors = (await ctx.db
      .query("pricesActive")
      .withIndex("by_ends_at", (q: any) =>
        q.gte("ends_at", 0).lte("ends_at", t),
      )
      .take(PRICE_TRANSITION_BATCH_LIMIT)) as {
      _id: string;
      product_id?: string;
    }[];
    for (const mirror of expiredMirrors) {
      await ctx.db.delete(mirror._id);
      if (mirror.product_id) touchedProducts.add(mirror.product_id);
    }
    const expirationsDrained =
      expiredMirrors.length < PRICE_TRANSITION_BATCH_LIMIT;

    // Phase B: due-time activation journal drain. Every processed row
    // recomputes its product: refresh records (due at starts_at) exist
    // precisely to update stored summaries at the activation instant, when
    // the mirror set itself does not change.
    const due = (await ctx.db
      .query("priceTransitions")
      .withIndex("by_due", (q: any) => q.lte("due_at", t))
      .take(PRICE_TRANSITION_BATCH_LIMIT + 1)) as {
      _id: string;
      price_id: string;
    }[];
    const activationsDrained = due.length <= PRICE_TRANSITION_BATCH_LIMIT;
    let synced = 0;
    for (const row of due.slice(0, PRICE_TRANSITION_BATCH_LIMIT)) {
      const price = (await ctx.db.get(row.price_id as any)) as PriceDoc | null;
      if (price) {
        if (await syncPriceActiveRow(ctx, price, t)) synced += 1;
        if (price.product_id) touchedProducts.add(price.product_id);
      }
      await ctx.db.delete(row._id);
    }

    for (const productId of touchedProducts) {
      await recomputeProductListSummary(ctx, productId);
    }
    const drained = expirationsDrained && activationsDrained;
    if (!drained) {
      await ctx.scheduler.runAfter(0, anyApi.prices.scheduleTransition, {
        now: t,
      });
    }
    return {
      expired: expiredMirrors.length,
      activated: synced,
      refreshed: touchedProducts.size,
      drained,
      remainingMayExist: !drained,
    };
  },
});

/**
 * Migration for pre-journal prices: paginate the full price table in
 * bounded chunks, sync the active mirror for anything materializable, and
 * write missing next-activation records for future prices. Idempotent —
 * already-mirrored/already-journaled rows are skipped — and safe to re-run
 * until done.
 */
export const backfillPriceTransitions = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), PRICE_TRANSITION_BATCH_LIMIT);
    const result = await ctx.db
      .query("prices")
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const t = now();
    let synced = 0;
    let journaled = 0;
    const touchedProducts = new Set<string>();
    for (const price of result.page as PriceDoc[]) {
      if (await syncPriceActiveRow(ctx, price, t)) {
        synced += 1;
        if (price.product_id) touchedProducts.add(price.product_id);
      }
      if (await journalPriceActivation(ctx, price, t)) journaled += 1;
    }
    for (const productId of touchedProducts) {
      await recomputeProductListSummary(ctx, productId);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.prices.backfillPriceTransitions, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      done: result.isDone,
      processed: result.page.length,
      synced,
      journaled,
      nextCursor: result.isDone ? undefined : result.continueCursor,
    };
  },
});

export const backfillPriceSummaries = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const result = await ctx.db
      .query("prices")
      .withIndex("by_price_summary_version", (q: any) =>
        // Stale means missing (undefined) OR any version older than current.
        q.lt("priceSummaryVersion", PRICE_SUMMARY_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let patched = 0;
    const t = now();
    for (const price of result.page as PriceDoc[]) {
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
      if (
        price.product_id !== patch.product_id ||
        price.storeName !== patch.storeName ||
        price.priceSummaryVersion !== patch.priceSummaryVersion
      ) {
        await ctx.db.patch(price._id as any, patch);
        patched += 1;
      }
      await syncPriceActiveRow(
        ctx,
        { ...price, ...patch } as PriceDoc,
        t,
      );
      await journalPriceActivation(
        ctx,
        { ...price, ...patch } as PriceDoc,
        t,
      );
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.prices.backfillPriceSummaries, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      processed: result.page.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});
