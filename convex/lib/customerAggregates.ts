import { money } from "../helpers";
import { applyOrderMetricsChange } from "./dashboardMetrics";
import type { CustomerDoc, OrderDoc, OrderStatus } from "../model";

/**
 * Aggregate semantics (version 2):
 * - `order_count` counts an order while its status is one of
 *   confirmed/picking/packed/out_for_delivery/delivered.
 * - `total_spend` sums `total_amount` over the same statuses.
 * - `pending_payment` orders count toward neither until confirmed.
 * - Cancelling an order removes both its count and its full total.
 * - Refunding (only reachable from `delivered`) removes both as well;
 *   partial refunds are not supported by the schema.
 * - Deleting an order removes its contribution exactly as a cancellation.
 * Version 1 counted pending_payment orders; the v2 backfill reconciles rows
 * written under the old rule.
 */
export const CUSTOMER_ORDER_STATS_VERSION = 2;

export const CUSTOMER_STATS_INCLUDED_STATUSES: readonly OrderStatus[] = [
  "confirmed",
  "picking",
  "packed",
  "out_for_delivery",
  "delivered",
];

const includedStatuses = new Set<OrderStatus>(CUSTOMER_STATS_INCLUDED_STATUSES);

export function orderCountsForCustomerStats(order: OrderDoc | null) {
  if (!order || !includedStatuses.has(order.status)) {
    return { order_count: 0, total_spend: 0 };
  }
  return { order_count: 1, total_spend: order.total_amount };
}

export function customerSearchText(customer: {
  display_name?: string;
  email?: string;
  phone_country_code: string;
  phone_number: string;
}) {
  return [
    customer.display_name ?? "",
    customer.email ?? "",
    customer.phone_country_code,
    customer.phone_number,
    `${customer.phone_country_code}${customer.phone_number}`,
  ]
    .join(" ")
    .toLowerCase();
}

export async function adjustCustomerOrderStats(
  ctx: { db: any },
  customerId: string,
  delta: { order_count: number; total_spend: number },
) {
  if (delta.order_count === 0 && delta.total_spend === 0) return;
  const customer = (await ctx.db.get(customerId)) as CustomerDoc | null;
  if (!customer) return;
  await ctx.db.patch(customerId, {
    order_count: Math.max((customer.order_count ?? 0) + delta.order_count, 0),
    total_spend: money((customer.total_spend ?? 0) + delta.total_spend),
    customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
    // Every authoritative aggregate write bumps the generation so an
    // in-flight reconciliation detects the interleaving and restarts
    // instead of committing a stale snapshot.
    statsGeneration: (customer.statsGeneration ?? 0) + 1,
  });
}

export async function applyOrderStatsChange(
  ctx: { db: any },
  before: OrderDoc | null,
  after: OrderDoc | null,
) {
  // Dashboard order metrics share this funnel: every order create, amount
  // edit, status transition, reassignment, and delete flows through here.
  await applyOrderMetricsChange(ctx, before, after);
  const beforeStats = orderCountsForCustomerStats(before);
  const afterStats = orderCountsForCustomerStats(after);
  if (before?.customer_id && before.customer_id !== after?.customer_id) {
    await adjustCustomerOrderStats(ctx, before.customer_id, {
      order_count: -beforeStats.order_count,
      total_spend: -beforeStats.total_spend,
    });
  }
  if (after?.customer_id) {
    await adjustCustomerOrderStats(ctx, after.customer_id, {
      order_count:
        before?.customer_id === after.customer_id
          ? afterStats.order_count - beforeStats.order_count
          : afterStats.order_count,
      total_spend:
        before?.customer_id === after.customer_id
          ? afterStats.total_spend - beforeStats.total_spend
          : afterStats.total_spend,
    });
  }
}
