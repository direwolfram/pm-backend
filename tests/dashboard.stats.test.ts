import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import {
  manilaDayKey,
  manilaDayStartMs,
  ORDER_METRICS_LIFETIME_KEY,
  orderMetricsDailyKey,
} from "../convex/lib/dashboardMetrics";
import type { DashboardStats } from "../convex/model";

const modules = import.meta.glob("../convex/**/*.ts");

// Manila "today" throughout: 2026-03-10T16:00:00.000Z == 2026-03-11 00:00 +08.
const NOW = Date.parse("2026-03-10T16:00:00.000Z");
const TODAY = "2026-03-11";
const DAY_START = manilaDayStartMs(TODAY); // === NOW

type T = ReturnType<typeof convexTest>;

async function seedBase(t: T) {
  const customerId = await t.mutation(api.customers.create, {
    phone_country_code: "+63",
    phone_number: "9000000001",
    display_name: "Dash Customer",
  });
  return await t.run(async (ctx) => {
    const storeId = await ctx.db.insert("stores", {
      name: "Dash Store",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    });
    const addressId = await ctx.db.insert("addresses", {
      customer_id: customerId,
      label: "home",
      title: "Home",
      full_address: "Home",
      country_code: "PH",
      latitude: 0,
      longitude: 0,
      is_default: true,
      created_at: 1,
      updated_at: 1,
    });
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: "cat",
      sort_order: 1,
      is_active: true,
    });
    return { customerId, storeId, addressId, categoryId };
  });
}

function orderArgs(
  ids: { customerId: Id<"customers">; storeId: Id<"stores">; addressId: Id<"addresses"> },
  n: number,
  opts?: { total?: number; placedAt?: number; status?: "pending_payment" | "confirmed" },
) {
  return {
    order_number: `PM-${n}`,
    customer_id: ids.customerId,
    store_id: ids.storeId,
    address_id: ids.addressId,
    delivery_mode: "express" as const,
    subtotal_amount: opts?.total ?? 100,
    total_amount: opts?.total ?? 100,
    ...(opts?.placedAt === undefined ? {} : { placed_at: opts.placedAt }),
    ...(opts?.status === undefined ? {} : { status: opts.status }),
  };
}

/** Insert orders directly, bypassing maintained aggregates (pre-migration data). */
async function insertOrdersRaw(
  t: T,
  ids: { customerId: Id<"customers">; storeId: Id<"stores">; addressId: Id<"addresses"> },
  specs: { total: number; status: string; placedAt: number }[],
) {
  const batchSize = 200;
  for (let start = 0; start < specs.length; start += batchSize) {
    const chunk = specs.slice(start, start + batchSize);
    await t.run(async (ctx) => {
      for (let n = 0; n < chunk.length; n += 1) {
        const spec = chunk[n];
        await ctx.db.insert("orders", {
          order_number: `PM-RAW-${start + n}`,
          customer_id: ids.customerId,
          store_id: ids.storeId,
          address_id: ids.addressId,
          delivery_mode: "express",
          status: spec.status,
          payment_status: "pending",
          currency: "PHP",
          subtotal_amount: spec.total,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: spec.total,
          placed_at: spec.placedAt,
        });
      }
    });
  }
}

async function lifetimeRow(t: T) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("metricAggregates")
      .withIndex("by_key", (q) => q.eq("key", ORDER_METRICS_LIFETIME_KEY))
      .first(),
  );
}

async function dailyRow(t: T, day: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("metricAggregates")
      .withIndex("by_key", (q) => q.eq("key", orderMetricsDailyKey(day)))
      .first(),
  );
}

async function stats(t: T): Promise<DashboardStats> {
  return await t.query(api.dashboard.stats, {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard.stats order metrics lifecycle", () => {
  it("tracks create, amount edit, cancel, refund, and delete exactly", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);

    const orderId = await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 100 }));
    let s = await stats(t);
    expect(s.total_orders).toBe(1);
    expect(s.orders_today).toBe(1);
    expect(s.revenue_total).toBe(100);
    expect(s.revenue_today).toBe(100);
    expect(await lifetimeRow(t)).toMatchObject({ count: 1, amount: 100 });
    expect(await dailyRow(t, TODAY)).toMatchObject({ count: 1, amount: 100 });

    // Amount edit applies the exact delta.
    await t.mutation(api.orders.updateAmounts, { id: orderId, total_amount: 150 });
    s = await stats(t);
    expect(s.revenue_total).toBe(150);
    expect(s.revenue_today).toBe(150);
    expect(s.total_orders).toBe(1);
    expect(s.orders_today).toBe(1);

    // Forward status changes within the revenue-counting states change nothing.
    await t.mutation(api.orders.updateStatus, { id: orderId, status: "confirmed" });
    s = await stats(t);
    expect(s.revenue_total).toBe(150);
    expect(s.total_orders).toBe(1);

    // Cancellation removes the full amount from revenue but keeps the counts.
    await t.mutation(api.orders.updateStatus, { id: orderId, status: "cancelled" });
    s = await stats(t);
    expect(s.revenue_total).toBe(0);
    expect(s.revenue_today).toBe(0);
    expect(s.total_orders).toBe(1);
    expect(s.orders_today).toBe(1);
    expect(await lifetimeRow(t)).toMatchObject({ count: 1, amount: 0 });
    expect(await dailyRow(t, TODAY)).toMatchObject({ count: 1, amount: 0 });

    // Deleting the order removes its contribution entirely.
    await t.mutation(api.orders.remove, { id: orderId });
    s = await stats(t);
    expect(s.total_orders).toBe(0);
    expect(s.orders_today).toBe(0);
    expect(s.revenue_total).toBe(0);
    expect(s.revenue_today).toBe(0);
  });

  it("removes revenue on refund after delivery", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    const orderId = await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 200 }));
    for (const status of ["confirmed", "picking", "packed", "out_for_delivery", "delivered"] as const) {
      await t.mutation(api.orders.updateStatus, { id: orderId, status });
    }
    let s = await stats(t);
    expect(s.revenue_total).toBe(200);
    await t.mutation(api.orders.updateStatus, { id: orderId, status: "refunded" });
    s = await stats(t);
    expect(s.revenue_total).toBe(0);
    expect(s.revenue_today).toBe(0);
    expect(s.total_orders).toBe(1);
    expect(s.orders_today).toBe(1);
  });

  it("keeps yesterday's orders out of today's metrics", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 100, placedAt: DAY_START - 1 }));
    await t.mutation(api.orders.create, orderArgs(ids, 2, { total: 50, placedAt: DAY_START }));
    const s = await stats(t);
    expect(s.total_orders).toBe(2);
    expect(s.orders_today).toBe(1);
    expect(s.revenue_total).toBe(150);
    expect(s.revenue_today).toBe(50);
    expect(await dailyRow(t, "2026-03-10")).toMatchObject({ count: 1, amount: 100 });
    expect(await dailyRow(t, TODAY)).toMatchObject({ count: 1, amount: 50 });
  });

  it("retries and no-op writes apply zero deltas and cannot double-count", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    const orderId = await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 100 }));

    // Same-status update is a documented no-op.
    await t.mutation(api.orders.updateStatus, { id: orderId, status: "pending_payment" });
    // Re-applying identical amounts is a zero delta.
    await t.mutation(api.orders.updateAmounts, { id: orderId, total_amount: 100 });
    // Deleting a missing order is a no-op.
    const missing = await t.run(async (ctx) => {
      const id = await ctx.db.insert("orders", {
        order_number: "PM-TMP",
        customer_id: ids.customerId,
        store_id: ids.storeId,
        address_id: ids.addressId,
        delivery_mode: "express",
        status: "confirmed",
        payment_status: "pending",
        currency: "PHP",
        subtotal_amount: 1,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: 1,
        placed_at: DAY_START,
      });
      await ctx.db.delete(id);
      return id;
    });
    await t.mutation(api.orders.remove, { id: missing });

    const s = await stats(t);
    expect(s.total_orders).toBe(1);
    expect(s.orders_today).toBe(1);
    expect(s.revenue_total).toBe(100);
    expect(s.revenue_today).toBe(100);
    expect(await lifetimeRow(t)).toMatchObject({ count: 1, amount: 100 });
    expect(await dailyRow(t, TODAY)).toMatchObject({ count: 1, amount: 100 });
  });
});

describe("Asia/Manila day boundaries", () => {
  it("computes Manila day keys and UTC day starts explicitly", () => {
    expect(manilaDayKey(Date.parse("2026-03-10T15:59:59.999Z"))).toBe("2026-03-10");
    expect(manilaDayKey(Date.parse("2026-03-10T16:00:00.000Z"))).toBe("2026-03-11");
    expect(manilaDayKey(Date.parse("2026-03-11T15:59:59.999Z"))).toBe("2026-03-11");
    expect(manilaDayStartMs("2026-03-11")).toBe(Date.parse("2026-03-10T16:00:00.000Z"));
    expect(manilaDayStartMs(manilaDayKey(NOW))).toBe(NOW);
  });

  it("buckets orders at the exact UTC boundary into the right Manila day", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    // 23:59:59.999 +08 on 2026-03-10 -> yesterday in Manila.
    await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 10, placedAt: DAY_START - 1 }));
    // 00:00:00.000 +08 on 2026-03-11 -> today in Manila.
    await t.mutation(api.orders.create, orderArgs(ids, 2, { total: 20, placedAt: DAY_START }));
    const s = await stats(t);
    expect(s.orders_today).toBe(1);
    expect(s.revenue_today).toBe(20);
    expect(s.total_orders).toBe(2);
    expect(s.revenue_total).toBe(30);
  });
});

describe("dashboard.stats inventory, catalog, and ticket counters", () => {
  it("tracks inventory status transitions through every writer", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    const productId = await t.mutation(api.products.create, {
      primary_category_id: ids.categoryId,
      name: "Dash Product",
      status: "active",
    });
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "DSKU-1",
      variant_label: "500g",
    });
    let s = await stats(t);
    expect(s.total_products).toBe(1);
    expect(s.active_products).toBe(1);
    expect(s.total_skus).toBe(1);

    const invId = await t.mutation(api.inventory.upsert, {
      sku_id: skuId,
      store_id: ids.storeId,
      quantity_available: 0,
    });
    s = await stats(t);
    expect(s.out_of_stock_count).toBe(1);
    expect(s.low_stock_count).toBe(0);

    await t.mutation(api.inventory.adjust, {
      sku_id: skuId,
      store_id: ids.storeId,
      delta: 10,
    });
    s = await stats(t);
    expect(s.out_of_stock_count).toBe(0);
    expect(s.low_stock_count).toBe(0);

    await t.mutation(api.inventory.adjust, {
      sku_id: skuId,
      store_id: ids.storeId,
      delta: -6,
    });
    s = await stats(t);
    expect(s.low_stock_count).toBe(1);

    await t.mutation(api.inventory.setThreshold, {
      sku_id: skuId,
      store_id: ids.storeId,
      low_stock_threshold: 2,
    });
    s = await stats(t);
    expect(s.low_stock_count).toBe(0);

    await t.mutation(api.inventory.setThreshold, {
      sku_id: skuId,
      store_id: ids.storeId,
      low_stock_threshold: 5,
    });
    s = await stats(t);
    expect(s.low_stock_count).toBe(1);

    await t.mutation(api.inventory.setUnavailable, {
      sku_id: skuId,
      store_id: ids.storeId,
      unavailable: true,
    });
    s = await stats(t);
    expect(s.low_stock_count).toBe(0);
    expect(s.out_of_stock_count).toBe(0);

    await t.mutation(api.inventory.setUnavailable, {
      sku_id: skuId,
      store_id: ids.storeId,
      unavailable: false,
    });
    s = await stats(t);
    expect(s.low_stock_count).toBe(1);

    await t.mutation(api.inventory.remove, { id: invId });
    s = await stats(t);
    expect(s.low_stock_count).toBe(0);
  });

  it("counts customers and open tickets", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("support_tickets", {
        customer_id: ids.customerId,
        status: "open",
        subject: "A",
        latest_message: "m",
        created_at: 1,
        updated_at: 1,
      });
      await ctx.db.insert("support_tickets", {
        customer_id: ids.customerId,
        status: "resolved",
        subject: "B",
        latest_message: "m",
        created_at: 1,
        updated_at: 1,
      });
    });
    // Bounded fallback path (no counters yet).
    let s = await stats(t);
    expect(s.total_customers).toBe(1);
    expect(s.open_tickets).toBe(1);
    // Reconciled (maintained) path agrees.
    await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "support_tickets",
    });
    s = await stats(t);
    expect(s.open_tickets).toBe(1);
  });

  it("counts only promotions active right now", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const base = {
        kind: "banner" as const,
        title: "P",
        currency: "PHP",
        is_active: true,
      };
      await ctx.db.insert("promotions", {
        ...base,
        title: "live",
        starts_at: NOW - 1_000,
        ends_at: NOW + 1_000,
      });
      await ctx.db.insert("promotions", {
        ...base,
        title: "expired",
        starts_at: NOW - 10_000,
        ends_at: NOW - 1_000,
      });
      await ctx.db.insert("promotions", {
        ...base,
        title: "future",
        starts_at: NOW + 1_000,
        ends_at: NOW + 10_000,
      });
      await ctx.db.insert("promotions", {
        ...base,
        title: "inactive",
        is_active: false,
        starts_at: NOW - 1_000,
        ends_at: NOW + 1_000,
      });
    });
    const s = await stats(t);
    expect(s.active_promotions).toBe(1);
  });
});

describe("dashboard.stats response contract", () => {
  it("returns exactly the documented shape", async () => {
    const t = convexTest({ schema, modules });
    await seedBase(t);
    const s = await stats(t);
    expect(Object.keys(s).sort()).toEqual(
      [
        "total_products",
        "active_products",
        "total_skus",
        "total_orders",
        "orders_today",
        "revenue_total",
        "revenue_today",
        "low_stock_count",
        "out_of_stock_count",
        "total_customers",
        "open_tickets",
        "active_promotions",
      ].sort(),
    );
    for (const value of Object.values(s)) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("recentOrders stays newest-first and bounded by limit", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 10, placedAt: DAY_START - 3 }));
    await t.mutation(api.orders.create, orderArgs(ids, 2, { total: 20, placedAt: DAY_START - 2 }));
    await t.mutation(api.orders.create, orderArgs(ids, 3, { total: 30, placedAt: DAY_START - 1 }));

    const all = await t.query(api.dashboard.recentOrders, {});
    expect(all.map((o) => o.order_number)).toEqual(["PM-3", "PM-2", "PM-1"]);
    expect(all[0]).toMatchObject({
      customer_name: "Dash Customer",
      store_name: "Dash Store",
    });

    const two = await t.query(api.dashboard.recentOrders, { limit: 2 });
    expect(two.map((o) => o.order_number)).toEqual(["PM-3", "PM-2"]);
  });
});

describe("dashboard.backfillOrderMetrics", () => {
  function rawSpecs(count: number) {
    return Array.from({ length: count }, (_, n) => ({
      total: (n % 7) + 1,
      status: n % 5 === 0 ? "cancelled" : n % 11 === 0 ? "refunded" : "confirmed",
      placedAt: DAY_START - ((n % 3) + 1) * 60_000 + (n % 3) * 86_400_000,
    }));
  }

  function expected(specs: { total: number; status: string; placedAt: number }[]) {
    const valid = specs.filter((s) => s.status !== "cancelled" && s.status !== "refunded");
    const today = specs.filter(
      (s) => s.placedAt >= DAY_START && s.placedAt < DAY_START + 86_400_000,
    );
    const todayValid = today.filter(
      (s) => s.status !== "cancelled" && s.status !== "refunded",
    );
    return {
      count: specs.length,
      amount: valid.reduce((sum, s) => sum + s.total, 0),
      todayCount: today.length,
      todayAmount: todayValid.reduce((sum, s) => sum + s.total, 0),
    };
  }

  it("paginates, resumes, and is idempotent", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    const specs = rawSpecs(250); // two 200-row chunks
    await insertOrdersRaw(t, ids, specs);

    const first = await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    expect(first).toMatchObject({ done: false, processed: 200 });
    const second = await t.mutation(internal.dashboard.backfillOrderMetrics, {
      cursor: (first as { nextCursor?: string }).nextCursor,
      totals: (first as { totals?: unknown }).totals,
      daily: (first as { daily?: unknown }).daily,
      mutationGeneration: first.mutationGeneration,
      restarts: first.restarts,
    });
    expect(second).toMatchObject({ done: true, processed: 50 });

    const want = expected(specs);
    expect(await lifetimeRow(t)).toMatchObject({
      count: want.count,
      amount: want.amount,
    });

    // Stats now reads the aggregates and agrees with the raw scan.
    const s = await stats(t);
    expect(s.total_orders).toBe(want.count);
    expect(s.revenue_total).toBe(want.amount);
    expect(s.orders_today).toBe(want.todayCount);
    expect(s.revenue_today).toBe(want.todayAmount);

    // Idempotent re-run: drains its chunks and patches nothing.
    await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await lifetimeRow(t)).toMatchObject({
      count: want.count,
      amount: want.amount,
    });
  });

  it("repairs drifted aggregates and deletes stale daily rows", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 42, placedAt: DAY_START }));

    // Corrupt the maintained rows out from under the live writers.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("metricAggregates")
        .withIndex("by_key", (q) => q.eq("key", ORDER_METRICS_LIFETIME_KEY))
        .first();
      await ctx.db.patch(row!._id, { count: 999, amount: 999 });
      await ctx.db.insert("metricAggregates", {
        key: orderMetricsDailyKey("1999-01-01"),
        day: "1999-01-01",
        count: 7,
        amount: 70,
      });
    });
    let s = await stats(t);
    expect(s.revenue_total).toBe(999); // drift is visible until repaired

    const result = await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    expect(result.done).toBe(true);
    expect(await lifetimeRow(t)).toMatchObject({ count: 1, amount: 42 });
    expect(await dailyRow(t, "1999-01-01")).toBeNull();

    s = await stats(t);
    expect(s.total_orders).toBe(1);
    expect(s.revenue_total).toBe(42);
  });

  it("restarts instead of clobbering live writes that land mid-scan", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    const specs = rawSpecs(250);
    await insertOrdersRaw(t, ids, specs);
    // Raw inserts bypass the orders list counter too; repair it so
    // total_orders reflects the full domain (the backfill only owns the
    // metricAggregates documents).
    await t.mutation(internal.listCounts.reconcileListCounts, { scope: "orders" });

    const first = await t.mutation(internal.dashboard.backfillOrderMetrics, {});
    expect(first.done).toBe(false);

    // A live order write lands between chunks (through the public mutation,
    // which applies its delta and bumps the mutation generation).
    await t.mutation(api.orders.create, orderArgs(ids, 999, { total: 77, placedAt: DAY_START }));

    const second = await t.mutation(internal.dashboard.backfillOrderMetrics, {
      cursor: (first as { nextCursor?: string }).nextCursor,
      totals: (first as { totals?: unknown }).totals,
      daily: (first as { daily?: unknown }).daily,
      mutationGeneration: first.mutationGeneration,
      restarts: 0,
    });
    expect(second).toMatchObject({ done: false, restarted: true });

    // The restarted pass drains via scheduled continuations and ends exact:
    // raw orders recomputed from scratch plus the live order applied once.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const want = expected(specs);
    expect(await lifetimeRow(t)).toMatchObject({
      count: want.count + 1,
      amount: want.amount + 77,
    });
    const s = await stats(t);
    expect(s.total_orders).toBe(want.count + 1);
    expect(s.revenue_total).toBe(want.amount + 77);
    expect(s.orders_today).toBe(want.todayCount + 1);
    expect(s.revenue_today).toBe(want.todayAmount + 77);
  });

  it("fails explicitly after too many mid-scan restarts", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await t.mutation(api.orders.create, orderArgs(ids, 1, { total: 1 }));
    await expect(
      t.mutation(internal.dashboard.backfillOrderMetrics, {
        mutationGeneration: 0, // stale: the live create already bumped it
        restarts: 5,
      }),
    ).rejects.toThrow(/restarted 5 times/);
  });
});

describe("dashboard.stats legacy fallback path", () => {
  it("serves correct stats before the backfill has run", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await insertOrdersRaw(t, ids, [
      { total: 100, status: "confirmed", placedAt: DAY_START },
      { total: 50, status: "cancelled", placedAt: DAY_START },
      { total: 25, status: "confirmed", placedAt: DAY_START - 86_400_000 },
    ]);
    const s = await stats(t);
    expect(s.orders_today).toBe(2);
    expect(s.revenue_today).toBe(100);
    expect(s.revenue_total).toBe(125);
  });

  it("rejects over-cap domains with explicit migration instructions", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBase(t);
    await insertOrdersRaw(
      t,
      ids,
      Array.from({ length: 513 }, (_, n) => ({
        total: 1,
        status: "confirmed",
        placedAt: DAY_START + n,
      })),
    );
    // Repair the orders list counter so the failure comes from the metrics path.
    let done = false;
    let cursor: string | undefined;
    let guard = 0;
    while (!done) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "orders",
        cursor,
      });
      done = result.done === true;
      cursor = done ? undefined : (result as { nextCursor?: string }).nextCursor;
    }
    await expect(t.query(api.dashboard.stats, {})).rejects.toThrow(
      /backfillOrderMetrics/,
    );
  });
});
