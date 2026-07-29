import { money } from "../helpers";
import type { OrderDoc } from "../model";

/**
 * Dashboard order metrics — maintained aggregates.
 *
 * Metric semantics (must match dashboard.stats):
 * - total_orders: every order document, including cancelled/refunded.
 * - revenue_total: sum of total_amount over orders whose status is NOT
 *   cancelled and NOT refunded. Cancelling or refunding removes the order's
 *   full total; amount edits apply the exact before/after delta; deleting an
 *   order removes its contribution exactly like a cancellation; no-op writes
 *   and retries apply a zero delta and cannot double-count.
 * - orders_today / revenue_today: the same count/valid-revenue restricted to
 *   orders whose placed_at falls on the current Asia/Manila calendar day.
 *   Asia/Manila is a fixed UTC+08:00 offset (no DST), so the day key and the
 *   UTC day-start boundary are computed explicitly below.
 *
 * Aggregates live in metricAggregates keyed "orders:lifetime" and
 * "orders:daily:<yyyy-mm-dd>" (Manila day). Every order mutation applies its
 * before/after delta in the same transaction via applyOrderStatsChange (the
 * single funnel all order writers already use). A mutation generation
 * ("orderMetricsMutations" in transitionState) is bumped on every delta so
 * dashboard.backfillOrderMetrics can detect live writes mid-scan and
 * restart instead of swapping in stale totals.
 */
export const ORDER_METRICS_LIFETIME_KEY = "orders:lifetime";
export const ORDER_METRICS_MUTATION_GENERATION_KEY = "orderMetricsMutations";

export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** yyyy-mm-dd of `t` on the Asia/Manila calendar. */
export function manilaDayKey(t: number): string {
  return new Date(t + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC epoch ms of 00:00:00 on the given Manila day key. */
export function manilaDayStartMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`) - MANILA_OFFSET_MS;
}

export function orderMetricsDailyKey(dayKey: string): string {
  return `orders:daily:${dayKey}`;
}

/** True when an order contributes to revenue (not cancelled/refunded). */
export function orderCountsForRevenue(order: OrderDoc | null): boolean {
  return !!order && order.status !== "cancelled" && order.status !== "refunded";
}

async function bumpMetric(
  ctx: { db: any },
  key: string,
  day: string | undefined,
  countDelta: number,
  amountDelta: number,
) {
  if (countDelta === 0 && amountDelta === 0) return;
  const row = await ctx.db
    .query("metricAggregates")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .first();
  if (!row) {
    await ctx.db.insert("metricAggregates", {
      key,
      day,
      count: countDelta,
      amount: money(amountDelta),
    });
    return;
  }
  await ctx.db.patch(row._id, {
    count: row.count + countDelta,
    amount: money(row.amount + amountDelta),
  });
}

async function bumpOrderMetricsMutationGeneration(ctx: { db: any }) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_MUTATION_GENERATION_KEY))
    .first();
  if (state) {
    await ctx.db.patch(state._id, { horizon: (state.horizon ?? 0) + 1 });
  } else {
    await ctx.db.insert("transitionState", {
      key: ORDER_METRICS_MUTATION_GENERATION_KEY,
      horizon: 1,
    });
  }
}

export async function currentOrderMetricsGeneration(ctx: { db: any }) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_MUTATION_GENERATION_KEY))
    .first();
  return (state?.horizon ?? 0) as number;
}

/**
 * Apply the before/after order change to the maintained dashboard metrics.
 * Deltas are computed from the effective before/after states only, so a
 * retried mutation or a write that changes nothing observable applies a zero
 * delta and cannot drift. The mutation generation is bumped only when a
 * delta was actually applied.
 */
export async function applyOrderMetricsChange(
  ctx: { db: any },
  before: OrderDoc | null,
  after: OrderDoc | null,
) {
  const beforeAmount = orderCountsForRevenue(before) ? before!.total_amount : 0;
  const afterAmount = orderCountsForRevenue(after) ? after!.total_amount : 0;
  const lifetimeCountDelta = (after ? 1 : 0) - (before ? 1 : 0);
  const lifetimeAmountDelta = afterAmount - beforeAmount;
  const beforeDay = before ? manilaDayKey(before.placed_at) : undefined;
  const afterDay = after ? manilaDayKey(after.placed_at) : undefined;
  let changed = false;
  if (lifetimeCountDelta !== 0 || lifetimeAmountDelta !== 0) {
    await bumpMetric(
      ctx,
      ORDER_METRICS_LIFETIME_KEY,
      undefined,
      lifetimeCountDelta,
      lifetimeAmountDelta,
    );
    changed = true;
  }
  if (beforeDay !== afterDay) {
    if (beforeDay) {
      await bumpMetric(
        ctx,
        orderMetricsDailyKey(beforeDay),
        beforeDay,
        before ? -1 : 0,
        -beforeAmount,
      );
      changed = true;
    }
    if (afterDay) {
      await bumpMetric(
        ctx,
        orderMetricsDailyKey(afterDay),
        afterDay,
        after ? 1 : 0,
        afterAmount,
      );
      changed = true;
    }
  } else if (afterDay) {
    const dayCountDelta = (after ? 1 : 0) - (before ? 1 : 0);
    if (dayCountDelta !== 0 || lifetimeAmountDelta !== 0) {
      await bumpMetric(
        ctx,
        orderMetricsDailyKey(afterDay),
        afterDay,
        dayCountDelta,
        lifetimeAmountDelta,
      );
      changed = true;
    }
  }
  if (changed) await bumpOrderMetricsMutationGeneration(ctx);
}

/** Point reads for dashboard.stats. Missing rows mean zero. */
export async function readOrderMetrics(ctx: { db: any }, dayKey: string) {
  const [lifetime, today] = await Promise.all([
    ctx.db
      .query("metricAggregates")
      .withIndex("by_key", (q: any) => q.eq("key", ORDER_METRICS_LIFETIME_KEY))
      .first(),
    ctx.db
      .query("metricAggregates")
      .withIndex("by_key", (q: any) => q.eq("key", orderMetricsDailyKey(dayKey)))
      .first(),
  ]);
  return {
    lifetime: { count: (lifetime?.count ?? 0) as number, amount: (lifetime?.amount ?? 0) as number },
    today: { count: (today?.count ?? 0) as number, amount: (today?.amount ?? 0) as number },
  };
}
