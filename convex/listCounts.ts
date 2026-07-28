import { v } from "convex/values";
import { anyApi } from "convex/server";
import { internalMutation } from "./functions";
import type { CustomerDoc, OrderDoc, ProductDoc } from "./model";

/**
 * Transactionally maintained exact totals for the admin list endpoints.
 *
 * Every public writer adjusts these counters in the same transaction as the
 * domain write; the only way they can drift is a direct DB write (seeds and
 * tests), repaired by reconcileListCounts, which paginates the source table
 * in fixed-size chunks, carries the accumulator across self-scheduled
 * continuations, and swaps all rows for the scope in one final transaction.
 *
 * Key formats (optional dimensions use "-"):
 * - customers: all | status:<status>
 * - orders:    all | status:<status> | store:<id> | store:<id>|status:<status>
 * - products:  all | status:<s> | category:<c> | brand:<b> |
 *              category:<c>|brand:<b> | category:<c>|status:<s> |
 *              brand:<b>|status:<s> | category:<c>|brand:<b>|status:<s>
 */
export type ListCountScope = "customers" | "orders" | "products";

const RECONCILE_BATCH_LIMIT = 200;
const MAX_DISTINCT_COUNT_KEYS = 5_000;

export function customerCountKeys(customer: {
  status: CustomerDoc["status"];
}) {
  return ["all", `status:${customer.status}`];
}

export function orderCountKeys(order: {
  status: OrderDoc["status"];
  store_id: string;
}) {
  return [
    "all",
    `status:${order.status}`,
    `store:${order.store_id}`,
    `store:${order.store_id}|status:${order.status}`,
  ];
}

export function productCountKeys(product: {
  status: ProductDoc["status"];
  primary_category_id: string;
  brand_id?: string;
}) {
  const category = product.primary_category_id;
  const brand = product.brand_id ?? "-";
  const status = product.status;
  return [
    "all",
    `status:${status}`,
    `category:${category}`,
    `brand:${brand}`,
    `category:${category}|brand:${brand}`,
    `category:${category}|status:${status}`,
    `brand:${brand}|status:${status}`,
    `category:${category}|brand:${brand}|status:${status}`,
  ];
}

export function customerTotalKey(args: { status?: string }) {
  return args.status ? `status:${args.status}` : "all";
}

export function orderTotalKey(args: { store_id?: string; status?: string }) {
  if (args.store_id && args.status) {
    return `store:${args.store_id}|status:${args.status}`;
  }
  if (args.store_id) return `store:${args.store_id}`;
  if (args.status) return `status:${args.status}`;
  return "all";
}

export function productTotalKey(args: {
  category_id?: string;
  brand_id?: string;
  status?: string;
}) {
  const category = args.category_id;
  const brand = args.brand_id ?? "-";
  const status = args.status;
  if (category && args.brand_id && status) {
    return `category:${category}|brand:${brand}|status:${status}`;
  }
  if (category && args.brand_id) return `category:${category}|brand:${brand}`;
  if (category && status) return `category:${category}|status:${status}`;
  if (args.brand_id && status) return `brand:${brand}|status:${status}`;
  if (category) return `category:${category}`;
  if (args.brand_id) return `brand:${brand}`;
  if (status) return `status:${status}`;
  return "all";
}

export async function bumpListCount(
  ctx: { db: any },
  scope: ListCountScope,
  key: string,
  delta: number,
) {
  if (delta === 0) return;
  const row = await ctx.db
    .query("listCounts")
    .withIndex("by_scope_key", (q: any) =>
      q.eq("scope", scope).eq("key", key),
    )
    .first();
  if (!row) {
    await ctx.db.insert("listCounts", { scope, key, count: delta });
    return;
  }
  await ctx.db.patch(row._id, { count: row.count + delta });
}

/** Apply a before/after document change to the maintained counters. */
export async function applyListCountChange<T>(
  ctx: { db: any },
  scope: ListCountScope,
  keysOf: (doc: T) => string[],
  before: T | null,
  after: T | null,
) {
  if (before) {
    for (const key of keysOf(before)) await bumpListCount(ctx, scope, key, -1);
  }
  if (after) {
    for (const key of keysOf(after)) await bumpListCount(ctx, scope, key, 1);
  }
}

/**
 * O(1) exact total for an equality-filtered list query. Returns undefined
 * when no counter row exists yet (only possible after direct DB writes that
 * bypass the public mutations or before reconcileListCounts has run), in
 * which case callers fall back to a bounded count of the match domain.
 */
export async function exactListTotal(
  ctx: { db: any },
  scope: ListCountScope,
  key: string,
) {
  const row = await ctx.db
    .query("listCounts")
    .withIndex("by_scope_key", (q: any) =>
      q.eq("scope", scope).eq("key", key),
    )
    .first();
  return row?.count as number | undefined;
}

function scopeTable(scope: ListCountScope) {
  return scope;
}

function keysForRow(scope: ListCountScope, row: any) {
  if (scope === "customers") return customerCountKeys(row);
  if (scope === "orders") return orderCountKeys(row);
  return productCountKeys(row);
}

/**
 * Bounded, resumable, idempotent rebuild of every counter of one scope.
 * Continuations carry (cursor, accumulator); the final chunk swaps all rows
 * transactionally, so public reads always see a complete set of counters.
 */
export const reconcileListCounts = internalMutation({
  args: {
    scope: v.union(
      v.literal("customers"),
      v.literal("orders"),
      v.literal("products"),
    ),
    cursor: v.optional(v.string()),
    counts: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const accumulator = new Map<string, number>(
      Object.entries((args.counts as Record<string, number> | undefined) ?? {}),
    );
    const result = await ctx.db
      .query(scopeTable(args.scope))
      .order("asc")
      .paginate({ numItems: RECONCILE_BATCH_LIMIT, cursor: args.cursor ?? null });
    for (const row of result.page as any[]) {
      for (const key of keysForRow(args.scope, row)) {
        accumulator.set(key, (accumulator.get(key) ?? 0) + 1);
      }
    }
    if (!result.isDone) {
      if (accumulator.size > MAX_DISTINCT_COUNT_KEYS) {
        throw new Error(
          `More than ${MAX_DISTINCT_COUNT_KEYS} distinct count keys for ${args.scope}`,
        );
      }
      await ctx.scheduler.runAfter(0, anyApi.listCounts.reconcileListCounts, {
        scope: args.scope,
        cursor: result.continueCursor,
        counts: Object.fromEntries(accumulator),
      });
      return {
        done: false,
        processed: result.page.length,
        distinctKeys: accumulator.size,
        nextCursor: result.continueCursor,
      };
    }
    // Final chunk: swap every counter for the scope in one transaction.
    const existing = (await ctx.db
      .query("listCounts")
      .withIndex("by_scope", (q: any) => q.eq("scope", args.scope))
      .take(MAX_DISTINCT_COUNT_KEYS + 1)) as {
      _id: string;
      key: string;
      count: number;
    }[];
    if (existing.length > MAX_DISTINCT_COUNT_KEYS) {
      throw new Error(
        `More than ${MAX_DISTINCT_COUNT_KEYS} count rows for ${args.scope}`,
      );
    }
    const existingByKey = new Map(existing.map((row) => [row.key, row]));
    for (const [key, count] of accumulator) {
      const row = existingByKey.get(key);
      if (!row) {
        await ctx.db.insert("listCounts", {
          scope: args.scope,
          key,
          count,
        });
      } else if (row.count !== count) {
        await ctx.db.patch(row._id, { count });
      }
      existingByKey.delete(key);
    }
    for (const row of existingByKey.values()) {
      await ctx.db.delete(row._id);
    }
    return {
      done: true,
      processed: result.page.length,
      distinctKeys: accumulator.size,
    };
  },
});
