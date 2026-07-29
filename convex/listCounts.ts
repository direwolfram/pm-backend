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
 * - skus:      all
 * - inventory: status:<status>            (dashboard stock-state counts)
 * - support_tickets: all | status:<status> (dashboard open-ticket count)
 */
export type ListCountScope =
  | "customers"
  | "orders"
  | "products"
  | "skus"
  | "inventory"
  | "support_tickets";

const RECONCILE_BATCH_LIMIT = 200;
const MAX_DISTINCT_COUNT_KEYS = 5_000;

/**
 * Maximum times a single reconcile pass may restart after live writes landed
 * mid-scan. Beyond this the run fails explicitly instead of starving under
 * continuous write volume.
 */
export const MAX_RECONCILE_RESTARTS = 5;

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

function mutationGenerationStateKey(scope: ListCountScope) {
  return `listCountsMutations:${scope}`;
}

async function currentMutationGeneration(ctx: { db: any }, scope: ListCountScope) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", mutationGenerationStateKey(scope)))
    .first();
  return (state?.horizon ?? 0) as number;
}

/**
 * Transactionally bumped by every live list-count update (once per
 * applyListCountChange call). reconcileListCounts snapshots this generation
 * at run start and restarts its scan when it changed mid-run, so writes
 * committed during reconciliation are never clobbered by a stale final swap.
 * The reconcile swap itself writes counters directly and does NOT bump this.
 */
export async function bumpListCountMutationGeneration(
  ctx: { db: any },
  scope: ListCountScope,
) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", mutationGenerationStateKey(scope)))
    .first();
  if (state) {
    await ctx.db.patch(state._id, { horizon: (state.horizon ?? 0) + 1 });
  } else {
    await ctx.db.insert("transitionState", {
      key: mutationGenerationStateKey(scope),
      horizon: 1,
    });
  }
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
  if (before || after) await bumpListCountMutationGeneration(ctx, scope);
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

export function skuCountKeys() {
  return ["all"];
}

export function inventoryCountKeys(row: { status?: string }) {
  return row.status ? [`status:${row.status}`] : [];
}

export function supportTicketCountKeys(row: { status: string }) {
  return ["all", `status:${row.status}`];
}

function keysForRow(scope: ListCountScope, row: any) {
  if (scope === "customers") return customerCountKeys(row);
  if (scope === "orders") return orderCountKeys(row);
  if (scope === "products") return productCountKeys(row);
  if (scope === "skus") return skuCountKeys();
  if (scope === "inventory") return inventoryCountKeys(row);
  return supportTicketCountKeys(row);
}

function reconcileStateKey(scope: ListCountScope) {
  return `listCountsReconcile:${scope}`;
}

/**
 * Read-and-check the run generation for a reconcile pass. Every restart of
 * reconcileListCounts bumps the generation transactionally; continuations
 * and the final swap verify it, so an older run that is still in flight when
 * a newer one starts aborts instead of overwriting fresh counters with a
 * stale snapshot.
 */
async function currentReconcileGeneration(ctx: { db: any }, scope: ListCountScope) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", reconcileStateKey(scope)))
    .first();
  return { state, generation: (state?.horizon ?? 0) as number };
}

/**
 * Bounded, resumable, idempotent rebuild of every counter of one scope.
 * Continuations carry (cursor, accumulator, generation); the final chunk
 * verifies the generation and swaps all rows in the same transaction, so
 * public reads always see a complete set of counters and overlapping runs
 * can never interleave their swaps — the superseded run aborts explicitly.
 */
export const reconcileListCounts = internalMutation({
  args: {
    scope: v.union(
      v.literal("customers"),
      v.literal("orders"),
      v.literal("products"),
      v.literal("skus"),
      v.literal("inventory"),
      v.literal("support_tickets"),
    ),
    cursor: v.optional(v.string()),
    counts: v.optional(v.any()),
    generation: v.optional(v.number()),
    mutationGeneration: v.optional(v.number()),
    restarts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let generation = args.generation;
    if (generation === undefined) {
      const { state, generation: current } = await currentReconcileGeneration(
        ctx,
        args.scope,
      );
      if (args.cursor === undefined || !state) {
        // Run start: claim a new generation. Any older run still in flight
        // is superseded and aborts at its next continuation.
        generation = current + 1;
        if (state) {
          await ctx.db.patch(state._id, { horizon: generation });
        } else {
          await ctx.db.insert("transitionState", {
            key: reconcileStateKey(args.scope),
            horizon: generation,
          });
        }
      } else {
        // Manual continuation of the in-flight run (cursor without an
        // explicit generation): adopt the current generation.
        generation = current;
      }
    } else {
      const { generation: current } = await currentReconcileGeneration(ctx, args.scope);
      if (current !== generation) {
        return {
          done: false,
          superseded: true,
          processed: 0,
          generation,
        };
      }
    }
    const mutationGeneration =
      args.mutationGeneration ??
      (await currentMutationGeneration(ctx, args.scope));
    const restarts = args.restarts ?? 0;
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
        generation,
        mutationGeneration,
        restarts,
      });
      return {
        done: false,
        processed: result.page.length,
        distinctKeys: accumulator.size,
        nextCursor: result.continueCursor,
        generation,
        mutationGeneration,
        restarts,
        counts: Object.fromEntries(accumulator),
      };
    }
    // Final chunk, two protections verified in the same transaction as the
    // swap:
    // 1. run generation — a superseded run aborts instead of overwriting the
    //    newer run's counters;
    // 2. mutation generation — live writes committed mid-scan bumped it, so
    //    this snapshot is stale: restart the scan from scratch (bounded by
    //    MAX_RECONCILE_RESTARTS) instead of clobbering the live counters.
    const { generation: currentGeneration } = await currentReconcileGeneration(
      ctx,
      args.scope,
    );
    if (currentGeneration !== generation) {
      return {
        done: false,
        superseded: true,
        processed: result.page.length,
        generation,
      };
    }
    const finalMutationGeneration = await currentMutationGeneration(ctx, args.scope);
    if (finalMutationGeneration !== mutationGeneration) {
      if (restarts + 1 > MAX_RECONCILE_RESTARTS) {
        throw new Error(
          `reconcileListCounts for ${args.scope} restarted ${restarts} times because writes kept landing mid-scan; retry under lower write volume`,
        );
      }
      const { state, generation: currentRun } = await currentReconcileGeneration(
        ctx,
        args.scope,
      );
      const nextGeneration = currentRun + 1;
      if (state) {
        await ctx.db.patch(state._id, { horizon: nextGeneration });
      } else {
        await ctx.db.insert("transitionState", {
          key: reconcileStateKey(args.scope),
          horizon: nextGeneration,
        });
      }
      await ctx.scheduler.runAfter(0, anyApi.listCounts.reconcileListCounts, {
        scope: args.scope,
        generation: nextGeneration,
        mutationGeneration: finalMutationGeneration,
        restarts: restarts + 1,
      });
      return {
        done: false,
        restarted: true,
        processed: result.page.length,
        generation: nextGeneration,
        mutationGeneration: finalMutationGeneration,
        restarts: restarts + 1,
      };
    }
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
      generation,
    };
  },
});
