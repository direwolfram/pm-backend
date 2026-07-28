import { money } from "../helpers";
import type { CustomerDoc, OrderDoc } from "../model";

export const CUSTOMER_ORDER_STATS_VERSION = 1;

const excludedStatuses = new Set(["cancelled", "refunded"]);

export function orderCountsForCustomerStats(order: OrderDoc | null) {
  if (!order || excludedStatuses.has(order.status)) {
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
  });
}

export async function applyOrderStatsChange(
  ctx: { db: any },
  before: OrderDoc | null,
  after: OrderDoc | null,
) {
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
