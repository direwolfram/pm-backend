import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, internalMutation } from "./functions";
import { money } from "./helpers";
import {
  currentOrderMetricsGeneration,
  manilaDayKey,
  manilaDayStartMs,
  ORDER_METRICS_LIFETIME_KEY,
  orderMetricsDailyKey,
  readOrderMetrics,
} from "./lib/dashboardMetrics";
import { exactListTotal } from "./listCounts";
import type {
  CustomerDoc,
  InventoryDoc,
  OrderDoc,
  ProductDoc,
  SkuDoc,
} from "./model";
import type { DashboardStats } from "./model";

/**
 * Dashboard metric semantics (single source of truth):
 * - total_products / active_products: every product document / status
 *   "active" (products being deleted are gone only after the cascade
 *   completes; the counters track table contents exactly).
 * - total_skus: every SKU document.
 * - total_orders: every order document, including cancelled/refunded.
 * - total_customers: every customer document.
 * - low_stock_count / out_of_stock_count: inventory rows whose legacy
 *   status is exactly "low_stock" / "out_of_stock" (unavailable and
 *   in_stock never count; quick-commerce rows use quickStatus and are out
 *   of scope for these legacy counts).
 * - open_tickets: support tickets with status "open" (waiting_for_customer,
 *   resolved, closed do not count).
 * - active_promotions: promotions with is_active && starts_at <= now <
 *   ends_at. Activation/expiry is time-based: the count is computed per
 *   request from a bounded, fully-constrained index read — it changes as
 *   time passes without any writes.
 * - orders_today / revenue_today: orders placed on the current Asia/Manila
 *   calendar day (fixed UTC+08:00, explicit conversion in
 *   lib/dashboardMetrics.ts).
 * - revenue_total / revenue_today: sum of total_amount over orders whose
 *   status is NOT cancelled and NOT refunded (pending_payment and
 *   unsuccessful orders still count, matching the legacy contract).
 *   Cancellation/refund removes the full total; amount edits apply exact
 *   deltas; deletes remove the contribution; item edits do not affect
 *   totals (amounts live on the order).
 *
 * Reads: maintained counters (listCounts) and metricAggregates point
 * lookups only — never a full-table collect. Missing counters fall back to
 * a bounded take(CAP+1) count that fails explicitly with reconcile
 * instructions; order metrics fall back to the legacy bounded computation
 * until dashboard.backfillOrderMetrics records completion.
 */
export const DASHBOARD_SCAN_CAP = 512;

const ORDER_METRICS_BACKFILL_STATE_KEY = "orderMetricsBackfill";

interface IndexRangeBuilder {
  eq(fieldName: string, value: unknown): IndexRangeBuilder;
  lte(fieldName: string, value: unknown): IndexRangeBuilder;
}

interface QueryBuilder<T> {
  withIndex(
    indexName: string,
    indexRange?: (q: IndexRangeBuilder) => IndexRangeBuilder,
  ): QueryBuilder<T>;
  order(direction: "asc" | "desc"): QueryBuilder<T>;
  take(n: number): Promise<T[]>;
}

interface DbReader {
  get(id: string): Promise<unknown | null>;
  query<T = unknown>(tableName: string): QueryBuilder<T>;
}

function alertLimit(limit?: number) {
  return Math.min(Math.max(limit ?? 12, 1), 100);
}

async function fetchById<T>(
  ctx: { db: DbReader },
  ids: string[],
): Promise<Map<string, T | null>> {
  const out = new Map<string, T | null>();
  await Promise.all(
    Array.from(new Set(ids)).map(async (id) => {
      out.set(id, (await ctx.db.get(id)) as T | null);
    }),
  );
  return out;
}

type CountScope = "products" | "skus" | "orders" | "customers" | "inventory" | "support_tickets";

/** Maintained counter, or a bounded count that rejects over-cap domains. */
async function counterOrBoundedCount(
  ctx: { db: any },
  scope: CountScope,
  key: string,
  countRows: () => Promise<unknown[]>,
): Promise<number> {
  const maintained = await exactListTotal(ctx, scope, key);
  if (maintained !== undefined) return maintained;
  const rows = await countRows();
  if (rows.length > DASHBOARD_SCAN_CAP) {
    throw new Error(
      `Dashboard counters are missing for ${scope}/${key} and more than ${DASHBOARD_SCAN_CAP} rows match; run listCounts.reconcileListCounts for scope "${scope}"`,
    );
  }
  return rows.length;
}

async function orderMetricsMigrationComplete(ctx: { db: any }) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_BACKFILL_STATE_KEY))
    .first();
  return state?.complete === true;
}

export async function statsHandler(
  ctx: { db: any },
  t: number,
): Promise<DashboardStats> {
    const dayKey = manilaDayKey(t);
    const dayStartMs = manilaDayStartMs(dayKey);

    const [
      totalProducts,
      activeProducts,
      totalSkus,
      totalOrders,
      totalCustomers,
      lowStock,
      outOfStock,
      openTickets,
      activePromoRows,
      orderMetricsReady,
    ] = await Promise.all([
      counterOrBoundedCount(ctx, "products", "all", () =>
        ctx.db.query("products").take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "products", "status:active", () =>
        ctx.db
          .query("products")
          .withIndex("by_status", (q: any) => q.eq("status", "active"))
          .take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "skus", "all", () =>
        ctx.db.query("skus").take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "orders", "all", () =>
        ctx.db.query("orders").take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "customers", "all", () =>
        ctx.db.query("customers").take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "inventory", "status:low_stock", () =>
        ctx.db
          .query("inventory")
          .withIndex("by_status_quantity", (q: any) => q.eq("status", "low_stock"))
          .take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "inventory", "status:out_of_stock", () =>
        ctx.db
          .query("inventory")
          .withIndex("by_status_quantity", (q: any) => q.eq("status", "out_of_stock"))
          .take(DASHBOARD_SCAN_CAP + 1),
      ),
      counterOrBoundedCount(ctx, "support_tickets", "status:open", () =>
        ctx.db
          .query("support_tickets")
          .withIndex("by_status", (q: any) => q.eq("status", "open"))
          .take(DASHBOARD_SCAN_CAP + 1),
      ),
      // Time-based activation cannot be a persisted counter: bounded read of
      // active promotions that have started, capped and fully constrained.
      ctx.db
        .query("promotions")
        .withIndex("by_active_starts", (q: any) =>
          q.eq("is_active", true).lte("starts_at", t),
        )
        .take(DASHBOARD_SCAN_CAP + 1),
      orderMetricsMigrationComplete(ctx),
    ]);
    if (activePromoRows.length > DASHBOARD_SCAN_CAP) {
      throw new Error(
        `More than ${DASHBOARD_SCAN_CAP} active promotions have started; deactivate expired campaigns before loading the dashboard`,
      );
    }
    const activePromotions = (activePromoRows as { ends_at: number }[]).filter(
      (promo) => promo.ends_at > t,
    ).length;

    let ordersToday: number;
    let revenueToday: number;
    let revenueTotal: number;
    const lifetimeRow = await ctx.db
      .query("metricAggregates")
      .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_LIFETIME_KEY))
      .first();
    if (lifetimeRow || orderMetricsReady) {
      const metrics = await readOrderMetrics(ctx, dayKey);
      ordersToday = metrics.today.count;
      revenueToday = metrics.today.amount;
      revenueTotal = metrics.lifetime.amount;
    } else {
      // Pre-backfill legacy path (bounded): correct for small catalogs, and
      // over-cap domains are rejected with explicit migration instructions.
      const orders = (await ctx.db
        .query("orders")
        .take(DASHBOARD_SCAN_CAP + 1)) as OrderDoc[];
      if (orders.length > DASHBOARD_SCAN_CAP) {
        throw new Error(
          `Order metrics are not backfilled and more than ${DASHBOARD_SCAN_CAP} orders exist; run dashboard.backfillOrderMetrics before loading the dashboard`,
        );
      }
      const valid = orders.filter(
        (order) => order.status !== "cancelled" && order.status !== "refunded",
      );
      const todayValid = valid.filter((order) => order.placed_at >= dayStartMs);
      ordersToday = orders.filter((order) => order.placed_at >= dayStartMs).length;
      revenueToday = money(todayValid.reduce((sum, order) => sum + order.total_amount, 0));
      revenueTotal = money(valid.reduce((sum, order) => sum + order.total_amount, 0));
    }

    return {
      total_products: totalProducts,
      active_products: activeProducts,
      total_skus: totalSkus,
      total_orders: totalOrders,
      orders_today: ordersToday,
      revenue_total: revenueTotal,
      revenue_today: revenueToday,
      low_stock_count: lowStock,
      out_of_stock_count: outOfStock,
      total_customers: totalCustomers,
      open_tickets: openTickets,
      active_promotions: activePromotions,
    };
}

export const stats = query({
  args: {},
  handler: async (ctx): Promise<DashboardStats> => statsHandler(ctx, Date.now()),
});

export async function recentOrdersHandler(
  ctx: { db: DbReader },
  args: { limit?: number },
) {
  // Bounded: one indexed page (newest-first by placed_at) plus point lookups
  // for only the customers/stores referenced by that page — never a
  // full-table collect, no matter how large orders/customers/stores grow.
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 100);
  const orders = (await ctx.db
    .query("orders")
    .withIndex("by_placed")
    .order("desc")
    .take(limit)) as OrderDoc[];
  const [customers, stores] = await Promise.all([
    fetchById<CustomerDoc>(
      ctx,
      orders.map((o) => o.customer_id),
    ),
    fetchById<{ name: string }>(
      ctx,
      orders.map((o) => o.store_id),
    ),
  ]);
  return orders.map((o) => {
    const customer = customers.get(o.customer_id);
    return {
      ...o,
      customer_name:
        customer?.display_name ??
        `${customer?.phone_country_code ?? ""}${customer?.phone_number ?? ""}`,
      store_name: stores.get(o.store_id)?.name,
    };
  });
}

export const recentOrders = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    recentOrdersHandler(ctx as { db: DbReader }, args),
});

export async function lowStockAlertsHandler(
  ctx: { db: DbReader },
  args: { limit?: number },
) {
  const limit = alertLimit(args.limit);
  const [lowStock, outOfStock] = await Promise.all([
    ctx.db
      .query<InventoryDoc>("inventory")
      .withIndex("by_status_quantity", (q) =>
        q.eq("status", "low_stock"),
      )
      .take(limit),
    ctx.db
      .query<InventoryDoc>("inventory")
      .withIndex("by_status_quantity", (q) =>
        q.eq("status", "out_of_stock"),
      )
      .take(limit),
  ]);
  const candidates = ([...lowStock, ...outOfStock] as InventoryDoc[])
    .filter((i) => i.sku_id !== undefined && i.store_id !== undefined)
    .sort((a, b) => a.quantity_available - b.quantity_available)
    .slice(0, limit);

  const rowsMissingSkuSummary = candidates.filter(
    (row) =>
      row.skuCode === undefined ||
      row.variantLabel === undefined ||
      row.productName === undefined ||
      row.storeName === undefined,
  );
  const skuCache = await fetchById<SkuDoc>(
    ctx,
    rowsMissingSkuSummary.map((row) => row.sku_id),
  );
  const productCache = await fetchById<ProductDoc>(
    ctx,
    rowsMissingSkuSummary
      .map((row) => skuCache.get(row.sku_id)?.product_id)
      .filter((id): id is string => id !== undefined),
  );
  const storeCache = await fetchById<{ name: string }>(
    ctx,
    rowsMissingSkuSummary.map((row) => row.store_id),
  );

  const out = [];
  for (const row of candidates) {
    const sku = skuCache.get(row.sku_id);
    if (!sku && (row.skuCode === undefined || row.variantLabel === undefined)) {
      continue;
    }
    out.push({
      ...row,
      sku_code: row.skuCode ?? sku?.sku_code ?? "(deleted sku)",
      variant_label: row.variantLabel ?? sku?.variant_label ?? "(deleted sku)",
      product_name:
        row.productName ??
        (sku ? productCache.get(sku.product_id)?.name : undefined) ??
        "(deleted)",
      store_name:
        row.storeName ?? storeCache.get(row.store_id)?.name ?? "(deleted store)",
    });
  }
  return out;
}

export const lowStockAlerts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    lowStockAlertsHandler(ctx as { db: DbReader }, args),
});

const ORDER_METRICS_BATCH_LIMIT = 200;
const ORDER_METRICS_MAX_RESTARTS = 5;

/**
 * Internal-only rebuild of the maintained order metrics (metricAggregates).
 *
 * Usage: run `internal.dashboard.backfillOrderMetrics` once after deploy
 * (Convex dashboard → Functions). It paginates orders in bounded chunks,
 * self-continues until drained, and swaps the aggregates only when the
 * order-metrics mutation generation is unchanged since the scan started —
 * otherwise it restarts (bounded by ORDER_METRICS_MAX_RESTARTS), so live
 * order writes can never be clobbered by a stale scan. Completion is
 * recorded in transitionState ("orderMetricsBackfill"), which flips
 * dashboard.stats from the legacy bounded path to the aggregates.
 *
 * Verification: compare a swapped lifetime row against a one-off bounded
 * count/sum on a small catalog, or check dashboard.stats before/after.
 * Drift repair: simply re-run — it is idempotent, patches only changed
 * documents, and deletes daily rows that no longer have orders.
 */
export const backfillOrderMetrics = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    totals: v.optional(v.any()),
    daily: v.optional(v.any()),
    mutationGeneration: v.optional(v.number()),
    restarts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const mutationGeneration =
      args.mutationGeneration ?? (await currentOrderMetricsGeneration(ctx));
    const restarts = args.restarts ?? 0;
    const totals = (args.totals as { count?: number; amount?: number } | undefined) ?? {
      count: 0,
      amount: 0,
    };
    const daily = new Map<string, { count: number; amount: number }>(
      Object.entries(
        (args.daily as Record<string, { count: number; amount: number }> | undefined) ?? {},
      ),
    );
    const result = await ctx.db
      .query("orders")
      .order("asc")
      .paginate({ numItems: ORDER_METRICS_BATCH_LIMIT, cursor: args.cursor ?? null });
    for (const order of result.page as OrderDoc[]) {
      totals.count = (totals.count ?? 0) + 1;
      const day = manilaDayKey(order.placed_at);
      const bucket = daily.get(day) ?? { count: 0, amount: 0 };
      bucket.count += 1;
      if (order.status !== "cancelled" && order.status !== "refunded") {
        totals.amount = money((totals.amount ?? 0) + order.total_amount);
        bucket.amount = money(bucket.amount + order.total_amount);
      }
      daily.set(day, bucket);
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.dashboard.backfillOrderMetrics, {
        cursor: result.continueCursor,
        totals,
        daily: Object.fromEntries(daily),
        mutationGeneration,
        restarts,
      });
      return {
        done: false,
        processed: result.page.length,
        nextCursor: result.continueCursor,
        totals,
        daily: Object.fromEntries(daily),
        mutationGeneration,
        restarts,
      };
    }
    // Final chunk: swap only when no live order-metrics write landed mid-scan.
    const finalGeneration = await currentOrderMetricsGeneration(ctx);
    if (finalGeneration !== mutationGeneration) {
      if (restarts + 1 > ORDER_METRICS_MAX_RESTARTS) {
        throw new Error(
          `backfillOrderMetrics restarted ${restarts} times because order writes kept landing mid-scan; retry under lower write volume`,
        );
      }
      await ctx.scheduler.runAfter(0, anyApi.dashboard.backfillOrderMetrics, {
        mutationGeneration: finalGeneration,
        restarts: restarts + 1,
      });
      return {
        done: false,
        restarted: true,
        processed: result.page.length,
        mutationGeneration: finalGeneration,
        restarts: restarts + 1,
      };
    }
    // Swap: patch changed docs, insert missing, delete stale daily rows.
    const desired = new Map<string, { day?: string; count: number; amount: number }>();
    desired.set(ORDER_METRICS_LIFETIME_KEY, {
      count: totals.count ?? 0,
      amount: totals.amount ?? 0,
    });
    for (const [day, bucket] of daily) {
      desired.set(orderMetricsDailyKey(day), { day, ...bucket });
    }
    const existing = (await ctx.db
      .query("metricAggregates")
      .take(DASHBOARD_SCAN_CAP + 1)) as {
      _id: string;
      key: string;
      day?: string;
      count: number;
      amount: number;
    }[];
    if (existing.length > DASHBOARD_SCAN_CAP) {
      throw new Error(
        `More than ${DASHBOARD_SCAN_CAP} metric aggregate rows; reconcile with a dedicated workflow`,
      );
    }
    const existingByKey = new Map(existing.map((row) => [row.key, row]));
    let patched = 0;
    for (const [key, value] of desired) {
      const row = existingByKey.get(key);
      if (!row) {
        await ctx.db.insert("metricAggregates", { key, ...value });
        patched += 1;
      } else {
        if (row.count !== value.count || row.amount !== value.amount) {
          await ctx.db.patch(row._id, {
            count: value.count,
            amount: value.amount,
          });
          patched += 1;
        }
        existingByKey.delete(key);
      }
    }
    for (const row of existingByKey.values()) {
      await ctx.db.delete(row._id);
      patched += 1;
    }
    const state = await ctx.db
      .query("transitionState")
      .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_BACKFILL_STATE_KEY))
      .first();
    if (state) {
      await ctx.db.patch(state._id, { complete: true, cursor: null });
    } else {
      await ctx.db.insert("transitionState", {
        key: ORDER_METRICS_BACKFILL_STATE_KEY,
        complete: true,
      });
    }
    return {
      done: true,
      processed: result.page.length,
      patched,
      mutationGeneration,
      restarts,
    };
  },
});
