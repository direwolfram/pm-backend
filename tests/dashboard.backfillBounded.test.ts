import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { manilaDayStartMs, ORDER_METRICS_LIFETIME_KEY, orderMetricsDailyKey } from "../convex/lib/dashboardMetrics";

const modules = import.meta.glob("../convex/**/*.ts");
const DAY = manilaDayStartMs("2026-03-11");
type T = ReturnType<typeof convexTest>;

async function seed(t: T, count: number) {
  const customerId = await t.mutation(api.customers.create, { phone_country_code: "+63", phone_number: "9000099999" });
  const ids = await t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", { name: "S", status: "active", address: "A", latitude: 0, longitude: 0, timezone: "Asia/Manila", created_at: 1, updated_at: 1 });
    const addressId = await ctx.db.insert("addresses", { customer_id: customerId, label: "home", title: "H", full_address: "H", country_code: "PH", latitude: 0, longitude: 0, is_default: true, created_at: 1, updated_at: 1 });
    return { storeId, addressId };
  });
  for (let start = 0; start < count; start += 100) {
    await t.run(async (ctx) => {
      for (let n = start; n < Math.min(start + 100, count); n++) await ctx.db.insert("orders", {
        order_number: `BOUND-${n}`, customer_id: customerId, store_id: ids.storeId, address_id: ids.addressId,
        delivery_mode: "express", status: "confirmed", payment_status: "paid", currency: "PHP",
        subtotal_amount: 1, discount_amount: 0, delivery_fee_amount: 0, total_amount: 1,
        placed_at: DAY - n * 86_400_000,
      });
    });
  }
  return { customerId, ...ids };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(DAY); });
afterEach(() => vi.useRealTimers());

describe("bounded dashboard order-metric reconciliation", () => {
  it("rebuilds 513+ daily buckets without carrying history in scheduler payloads", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, 514);
    await t.mutation(internal.listCounts.reconcileListCounts, { scope: "orders" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const first = await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    expect(first).not.toHaveProperty("daily");
    expect(first).not.toHaveProperty("totals");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) => ctx.db.query("metricAggregates").collect());
    expect(rows.filter((row) => row.key.startsWith("orders:daily:")).length).toBe(514);
    expect(rows.some((row) => row.key.startsWith("orders:rebuild:"))).toBe(false);
    expect(rows.find((row) => row.key === ORDER_METRICS_LIFETIME_KEY)).toMatchObject({ count: 514, amount: 514 });
  });

  it("is idempotent on duplicate scan retries and removes stale rows in bounded pages", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, 514);
    await t.run(async (ctx) => {
      for (let n = 0; n < 513; n++) {
        const day = `1900-${String(Math.floor(n / 28) + 1).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}`;
        await ctx.db.insert("metricAggregates", { key: orderMetricsDailyKey(day), day, count: 9, amount: 9 });
      }
    });
    const first = await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    const duplicate = await t.mutation(internal.dashboard.backfillOrderMetrics, { runGeneration: first.runGeneration, mutationGeneration: first.mutationGeneration, restarts: 0 });
    expect(duplicate).toMatchObject({ duplicate: true, processed: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const stale = await t.run(async (ctx) => ctx.db.query("metricAggregates").withIndex("by_key", (q) => q.eq("key", orderMetricsDailyKey("1900-01-01"))).first());
    expect(stale).toBeNull();
  });

  it("preserves a supplied generation and rejects after the restart limit", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t, 0);
    await t.mutation(api.orders.create, {
      order_number: "LIVE-1",
      customer_id: ids.customerId,
      store_id: ids.storeId,
      address_id: ids.addressId,
      delivery_mode: "express",
      subtotal_amount: 1,
      total_amount: 1,
      placed_at: DAY,
    });
    await expect(t.mutation(internal.dashboard.backfillOrderMetrics, {
      mutationGeneration: 0,
      restarts: 5,
    })).rejects.toThrow(/restarted 5 times/);
  });
});
