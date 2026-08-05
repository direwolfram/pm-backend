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
import type { CustomerDoc, InventoryDoc, OrderDoc, ProductDoc, SkuDoc } from "./model";
import type { DashboardStats } from "./model";

export const DASHBOARD_SCAN_CAP = 512;
const ORDER_METRICS_BACKFILL_STATE_KEY = "orderMetricsBackfill";
const ORDER_METRICS_BATCH_LIMIT = 200;
const ORDER_METRICS_FINALIZE_LIMIT = 100;
const ORDER_METRICS_MAX_RESTARTS = 5;

interface IndexRangeBuilder {
  eq(fieldName: string, value: unknown): IndexRangeBuilder;
  lte(fieldName: string, value: unknown): IndexRangeBuilder;
}
interface QueryBuilder<T> {
  withIndex(indexName: string, indexRange?: (q: IndexRangeBuilder) => IndexRangeBuilder): QueryBuilder<T>;
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
async function fetchById<T>(ctx: { db: DbReader }, ids: string[]) {
  const out = new Map<string, T | null>();
  await Promise.all(Array.from(new Set(ids)).map(async (id) => out.set(id, (await ctx.db.get(id)) as T | null)));
  return out;
}

type CountScope = "products" | "skus" | "orders" | "customers" | "inventory" | "support_tickets";
async function counterOrBoundedCount(
  ctx: { db: any },
  scope: CountScope,
  key: string,
  countRows: () => Promise<unknown[]>,
) {
  const maintained = await exactListTotal(ctx, scope, key);
  if (maintained !== undefined) return maintained;
  const rows = await countRows();
  if (rows.length > DASHBOARD_SCAN_CAP) {
    throw new Error(`Dashboard counters are missing for ${scope}/${key} and more than ${DASHBOARD_SCAN_CAP} rows match; run listCounts.reconcileListCounts for scope "${scope}"`);
  }
  return rows.length;
}
async function orderMetricsMigrationComplete(ctx: { db: any }) {
  const state = await ctx.db.query("transitionState").withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_BACKFILL_STATE_KEY)).first();
  return state?.complete === true;
}

export async function statsHandler(ctx: { db: any }, t: number): Promise<DashboardStats> {
  const dayKey = manilaDayKey(t);
  const dayStartMs = manilaDayStartMs(dayKey);
  const [totalProducts, activeProducts, totalSkus, totalOrders, totalCustomers, lowStock, outOfStock, openTickets, activePromoRows, orderMetricsReady] = await Promise.all([
    counterOrBoundedCount(ctx, "products", "all", () => ctx.db.query("products").take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "products", "status:active", () => ctx.db.query("products").withIndex("by_status", (q: any) => q.eq("status", "active")).take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "skus", "all", () => ctx.db.query("skus").take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "orders", "all", () => ctx.db.query("orders").take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "customers", "all", () => ctx.db.query("customers").take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "inventory", "status:low_stock", () => ctx.db.query("inventory").withIndex("by_status_quantity", (q: any) => q.eq("status", "low_stock")).take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "inventory", "status:out_of_stock", () => ctx.db.query("inventory").withIndex("by_status_quantity", (q: any) => q.eq("status", "out_of_stock")).take(DASHBOARD_SCAN_CAP + 1)),
    counterOrBoundedCount(ctx, "support_tickets", "status:open", () => ctx.db.query("support_tickets").withIndex("by_status", (q: any) => q.eq("status", "open")).take(DASHBOARD_SCAN_CAP + 1)),
    ctx.db.query("promotions").withIndex("by_active_starts", (q: any) => q.eq("is_active", true).lte("starts_at", t)).take(DASHBOARD_SCAN_CAP + 1),
    orderMetricsMigrationComplete(ctx),
  ]);
  if (activePromoRows.length > DASHBOARD_SCAN_CAP) throw new Error(`More than ${DASHBOARD_SCAN_CAP} active promotions have started; deactivate expired campaigns before loading the dashboard`);
  const activePromotions = (activePromoRows as { ends_at: number }[]).filter((promo) => promo.ends_at > t).length;
  let ordersToday: number;
  let revenueToday: number;
  let revenueTotal: number;
  const lifetimeRow = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_LIFETIME_KEY)).first();
  if (lifetimeRow || orderMetricsReady) {
    const metrics = await readOrderMetrics(ctx, dayKey);
    ordersToday = metrics.today.count;
    revenueToday = metrics.today.amount;
    revenueTotal = metrics.lifetime.amount;
  } else {
    const orders = (await ctx.db.query("orders").take(DASHBOARD_SCAN_CAP + 1)) as OrderDoc[];
    if (orders.length > DASHBOARD_SCAN_CAP) throw new Error(`Order metrics are not backfilled and more than ${DASHBOARD_SCAN_CAP} orders exist; run dashboard.backfillOrderMetrics before loading the dashboard`);
    const valid = orders.filter((order) => order.status !== "cancelled" && order.status !== "refunded");
    const todayValid = valid.filter((order) => order.placed_at >= dayStartMs);
    ordersToday = orders.filter((order) => order.placed_at >= dayStartMs).length;
    revenueToday = money(todayValid.reduce((sum, order) => sum + order.total_amount, 0));
    revenueTotal = money(valid.reduce((sum, order) => sum + order.total_amount, 0));
  }
  return {
    total_products: totalProducts, active_products: activeProducts, total_skus: totalSkus,
    total_orders: totalOrders, orders_today: ordersToday, revenue_total: revenueTotal,
    revenue_today: revenueToday, low_stock_count: lowStock, out_of_stock_count: outOfStock,
    total_customers: totalCustomers, open_tickets: openTickets, active_promotions: activePromotions,
  };
}
export const stats = query({ args: {}, handler: async (ctx): Promise<DashboardStats> => statsHandler(ctx, Date.now()) });

export async function recentOrdersHandler(ctx: { db: DbReader }, args: { limit?: number }) {
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 100);
  const orders = (await ctx.db.query("orders").withIndex("by_placed").order("desc").take(limit)) as OrderDoc[];
  const [customers, stores] = await Promise.all([
    fetchById<CustomerDoc>(ctx, orders.map((o) => o.customer_id)),
    fetchById<{ name: string }>(ctx, orders.map((o) => o.store_id)),
  ]);
  return orders.map((o) => {
    const customer = customers.get(o.customer_id);
    return { ...o, customer_name: customer?.display_name ?? `${customer?.phone_country_code ?? ""}${customer?.phone_number ?? ""}`, store_name: stores.get(o.store_id)?.name };
  });
}
export const recentOrders = query({ args: { limit: v.optional(v.number()) }, handler: async (ctx, args) => recentOrdersHandler(ctx as { db: DbReader }, args) });

export async function lowStockAlertsHandler(ctx: { db: DbReader }, args: { limit?: number }) {
  const limit = alertLimit(args.limit);
  const [lowStock, outOfStock] = await Promise.all([
    ctx.db.query<InventoryDoc>("inventory").withIndex("by_status_quantity", (q) => q.eq("status", "low_stock")).take(limit),
    ctx.db.query<InventoryDoc>("inventory").withIndex("by_status_quantity", (q) => q.eq("status", "out_of_stock")).take(limit),
  ]);
  const candidates = ([...lowStock, ...outOfStock] as InventoryDoc[]).filter((i) => i.sku_id !== undefined && i.store_id !== undefined).sort((a, b) => a.quantity_available - b.quantity_available).slice(0, limit);
  const missing = candidates.filter((row) => row.skuCode === undefined || row.variantLabel === undefined || row.productName === undefined || row.storeName === undefined);
  const skuCache = await fetchById<SkuDoc>(ctx, missing.map((row) => row.sku_id));
  const productCache = await fetchById<ProductDoc>(ctx, missing.map((row) => skuCache.get(row.sku_id)?.product_id).filter((id): id is string => id !== undefined));
  const storeCache = await fetchById<{ name: string }>(ctx, missing.map((row) => row.store_id));
  const out = [];
  for (const row of candidates) {
    const sku = skuCache.get(row.sku_id);
    if (!sku && (row.skuCode === undefined || row.variantLabel === undefined)) continue;
    out.push({ ...row, sku_code: row.skuCode ?? sku?.sku_code ?? "(deleted sku)", variant_label: row.variantLabel ?? sku?.variant_label ?? "(deleted sku)", product_name: row.productName ?? (sku ? productCache.get(sku.product_id)?.name : undefined) ?? "(deleted)", store_name: row.storeName ?? storeCache.get(row.store_id)?.name ?? "(deleted store)" });
  }
  return out;
}
export const lowStockAlerts = query({ args: { limit: v.optional(v.number()) }, handler: async (ctx, args) => lowStockAlertsHandler(ctx as { db: DbReader }, args) });

function stagePrefix(runGeneration: number) { return `orders:rebuild:${runGeneration}:`; }
function stageLifetimeKey(runGeneration: number) { return `${stagePrefix(runGeneration)}lifetime`; }
function stageDailyPrefix(runGeneration: number) { return `${stagePrefix(runGeneration)}daily:`; }
function stageDailyKey(runGeneration: number, day: string) { return `${stageDailyPrefix(runGeneration)}${day}`; }
function prefixRange(q: any, prefix: string) { return q.gte("key", prefix).lt("key", `${prefix}\uffff`); }

async function stateRow(ctx: { db: any }) {
  return await ctx.db.query("transitionState").withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_BACKFILL_STATE_KEY)).first();
}
async function bumpMetricRow(ctx: { db: any }, key: string, day: string | undefined, count: number, amount: number) {
  if (count === 0 && amount === 0) return;
  const row = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => q.eq("key", key)).first();
  if (row) await ctx.db.patch(row._id, { count: row.count + count, amount: money(row.amount + amount) });
  else await ctx.db.insert("metricAggregates", { key, day, count, amount: money(amount) });
}
async function setMetricRow(ctx: { db: any }, key: string, day: string | undefined, count: number, amount: number) {
  const row = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => q.eq("key", key)).first();
  if (!row) return await ctx.db.insert("metricAggregates", { key, day, count, amount: money(amount) });
  if (row.count !== count || row.amount !== money(amount) || row.day !== day) await ctx.db.patch(row._id, { day, count, amount: money(amount) });
  return row._id;
}
async function assertRunCurrent(ctx: { db: any }, runGeneration: number, mutationGeneration: number) {
  const state = await stateRow(ctx);
  return state?.horizon === runGeneration && (await currentOrderMetricsGeneration(ctx)) === mutationGeneration;
}
async function scheduleRestart(ctx: any, runGeneration: number, restarts: number) {
  if (restarts + 1 > ORDER_METRICS_MAX_RESTARTS) throw new Error(`backfillOrderMetrics restarted ${restarts} times because order writes kept landing mid-scan; retry under lower write volume`);
  await ctx.scheduler.runAfter(0, anyApi.dashboard.cleanupOrderMetricsStaging, { runGeneration, restart: true, restarts: restarts + 1 });
}

/**
 * Bounded rebuild. Each scan invocation carries only cursor/generation data.
 * Per-day totals are persisted under a generation-specific staging prefix,
 * then promoted and stale live rows are reconciled in fixed-size pages.
 */
export const backfillOrderMetrics = internalMutation({
  args: {
    cursor: v.optional(v.string()), runGeneration: v.optional(v.number()),
    mutationGeneration: v.optional(v.number()), restarts: v.optional(v.number()),
    totals: v.optional(v.any()), daily: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const restarts = args.restarts ?? 0;
    let runGeneration = args.runGeneration;
    let mutationGeneration = args.mutationGeneration;
    let state = await stateRow(ctx);
    if (runGeneration === undefined && args.cursor !== undefined && state?.complete === false) runGeneration = state.horizon;
    if (runGeneration === undefined) {
      runGeneration = (state?.horizon ?? 0) + 1;
      mutationGeneration = await currentOrderMetricsGeneration(ctx);
      if (state) await ctx.db.patch(state._id, { horizon: runGeneration, cursor: null, complete: false });
      else await ctx.db.insert("transitionState", { key: ORDER_METRICS_BACKFILL_STATE_KEY, horizon: runGeneration, cursor: null, complete: false });
      await ctx.db.insert("metricAggregates", { key: stageLifetimeKey(runGeneration), count: 0, amount: 0 });
      state = await stateRow(ctx);
    }
    mutationGeneration ??= await currentOrderMetricsGeneration(ctx);
    if (state?.horizon !== runGeneration) return { done: false, superseded: true, processed: 0, runGeneration };
    const expectedCursor = state.cursor ?? undefined;
    if (expectedCursor !== args.cursor) return { done: false, duplicate: true, processed: 0, nextCursor: expectedCursor, runGeneration, mutationGeneration, restarts };

    const result = await ctx.db.query("orders").order("asc").paginate({ numItems: ORDER_METRICS_BATCH_LIMIT, cursor: args.cursor ?? null });
    const daily = new Map<string, { count: number; amount: number }>();
    let lifetimeCount = 0;
    let lifetimeAmount = 0;
    for (const order of result.page as OrderDoc[]) {
      lifetimeCount += 1;
      const day = manilaDayKey(order.placed_at);
      const bucket = daily.get(day) ?? { count: 0, amount: 0 };
      bucket.count += 1;
      if (order.status !== "cancelled" && order.status !== "refunded") {
        lifetimeAmount = money(lifetimeAmount + order.total_amount);
        bucket.amount = money(bucket.amount + order.total_amount);
      }
      daily.set(day, bucket);
    }
    await bumpMetricRow(ctx, stageLifetimeKey(runGeneration), undefined, lifetimeCount, lifetimeAmount);
    for (const [day, bucket] of daily) await bumpMetricRow(ctx, stageDailyKey(runGeneration, day), day, bucket.count, bucket.amount);
    await ctx.db.patch(state._id, { cursor: result.isDone ? null : result.continueCursor });
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.dashboard.backfillOrderMetrics, { cursor: result.continueCursor, runGeneration, mutationGeneration, restarts });
      return { done: false, processed: result.page.length, nextCursor: result.continueCursor, runGeneration, mutationGeneration, restarts };
    }
    if (!(await assertRunCurrent(ctx, runGeneration, mutationGeneration))) {
      await scheduleRestart(ctx, runGeneration, restarts);
      return { done: false, restarted: true, processed: result.page.length, runGeneration, mutationGeneration, restarts: restarts + 1 };
    }
    await ctx.scheduler.runAfter(0, anyApi.dashboard.finalizeOrderMetrics, { runGeneration, mutationGeneration, restarts, phase: "apply" });
    return { done: false, scanDone: true, processed: result.page.length, runGeneration, mutationGeneration, restarts };
  },
});

export const finalizeOrderMetrics = internalMutation({
  args: {
    runGeneration: v.number(), mutationGeneration: v.number(), restarts: v.number(),
    phase: v.union(v.literal("apply"), v.literal("stale")), cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await assertRunCurrent(ctx, args.runGeneration, args.mutationGeneration))) {
      await scheduleRestart(ctx, args.runGeneration, args.restarts);
      return { done: false, restarted: true };
    }
    if (args.phase === "apply") {
      if (!args.cursor) {
        const lifetime = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => q.eq("key", stageLifetimeKey(args.runGeneration))).first();
        await setMetricRow(ctx, ORDER_METRICS_LIFETIME_KEY, undefined, lifetime?.count ?? 0, lifetime?.amount ?? 0);
      }
      const page = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => prefixRange(q, stageDailyPrefix(args.runGeneration))).order("asc").paginate({ numItems: ORDER_METRICS_FINALIZE_LIMIT, cursor: args.cursor ?? null });
      for (const row of page.page as { day?: string; count: number; amount: number }[]) if (row.day) await setMetricRow(ctx, orderMetricsDailyKey(row.day), row.day, row.count, row.amount);
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, anyApi.dashboard.finalizeOrderMetrics, { ...args, cursor: page.continueCursor });
        return { done: false, phase: "apply", processed: page.page.length };
      }
      await ctx.scheduler.runAfter(0, anyApi.dashboard.finalizeOrderMetrics, { runGeneration: args.runGeneration, mutationGeneration: args.mutationGeneration, restarts: args.restarts, phase: "stale" });
      return { done: false, phase: "stale", processed: page.page.length };
    }
    const page = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => prefixRange(q, "orders:daily:")).order("asc").paginate({ numItems: ORDER_METRICS_FINALIZE_LIMIT, cursor: args.cursor ?? null });
    let deleted = 0;
    for (const row of page.page as { _id: string; day?: string }[]) {
      if (!row.day) continue;
      const staged = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => q.eq("key", stageDailyKey(args.runGeneration, row.day!))).first();
      if (!staged) { await ctx.db.delete(row._id); deleted += 1; }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.dashboard.finalizeOrderMetrics, { ...args, cursor: page.continueCursor });
      return { done: false, phase: "stale", processed: page.page.length, deleted };
    }
    if (!(await assertRunCurrent(ctx, args.runGeneration, args.mutationGeneration))) {
      await scheduleRestart(ctx, args.runGeneration, args.restarts);
      return { done: false, restarted: true };
    }
    const state = await stateRow(ctx);
    await ctx.db.patch(state._id, { complete: true, cursor: null });
    await ctx.scheduler.runAfter(0, anyApi.dashboard.cleanupOrderMetricsStaging, { runGeneration: args.runGeneration, restart: false, restarts: args.restarts });
    return { done: true, phase: "complete", processed: page.page.length, deleted };
  },
});

export const cleanupOrderMetricsStaging = internalMutation({
  args: { runGeneration: v.number(), restart: v.boolean(), restarts: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("metricAggregates").withIndex("by_key", (q: any) => prefixRange(q, stagePrefix(args.runGeneration))).take(ORDER_METRICS_FINALIZE_LIMIT);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === ORDER_METRICS_FINALIZE_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.dashboard.cleanupOrderMetricsStaging, args);
      return { done: false, deleted: rows.length };
    }
    if (args.restart) await ctx.scheduler.runAfter(0, anyApi.dashboard.backfillOrderMetrics, { restarts: args.restarts });
    return { done: true, deleted: rows.length, restarted: args.restart };
  },
});
