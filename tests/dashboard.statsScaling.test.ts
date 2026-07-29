import { describe, expect, it } from "vitest";
import { recentOrdersHandler, statsHandler } from "../convex/dashboard";
import {
  ORDER_METRICS_LIFETIME_KEY,
  manilaDayKey,
  orderMetricsDailyKey,
} from "../convex/lib/dashboardMetrics";
import { FakeConvexDb, doc } from "./fakeConvexDb";

const NOW = Date.parse("2026-03-10T16:00:00.000Z"); // Manila 2026-03-11 00:00
const TODAY = manilaDayKey(NOW);

const COUNTERS: [string, string, number][] = [
  ["products", "all", 9_001],
  ["products", "status:active", 8_002],
  ["skus", "all", 7_003],
  ["orders", "all", 6_004],
  ["customers", "all", 5_005],
  ["inventory", "status:low_stock", 406],
  ["inventory", "status:out_of_stock", 307],
  ["support_tickets", "status:open", 208],
];

function filler(prefix: string, count: number) {
  return Array.from({ length: count }, (_, n) => ({
    _id: `${prefix}-${n}`,
    _table: prefix,
  }));
}

function buildDb(sourceRows: number) {
  const orders = filler("o", Math.max(sourceRows, 8)).map((row, n) => ({
    ...row,
    placed_at: NOW - n,
    customer_id: `c-${n % 3}`,
    store_id: "store-1",
    status: "confirmed",
    total_amount: 10,
  }));
  return new FakeConvexDb({
    listCounts: COUNTERS.map(([scope, key, count], n) =>
      doc("listCounts", { _id: `lc-${n}`, scope, key, count }),
    ),
    metricAggregates: [
      doc("metricAggregates", {
        _id: "ma-lifetime",
        key: ORDER_METRICS_LIFETIME_KEY,
        count: 6_004,
        amount: 123_456.78,
      }),
      doc("metricAggregates", {
        _id: "ma-today",
        key: orderMetricsDailyKey(TODAY),
        day: TODAY,
        count: 12,
        amount: 345.6,
      }),
    ],
    promotions: [
      doc("promotions", {
        _id: "promo-1",
        is_active: true,
        starts_at: NOW - 1_000,
        ends_at: NOW + 1_000,
      }),
    ],
    orders,
    customers: filler("c", sourceRows).map((row) => ({
      ...row,
      display_name: "Customer",
    })),
    stores: [doc("stores", { _id: "store-1", name: "Store" })],
    products: filler("p", sourceRows),
    skus: filler("s", sourceRows),
    inventory: filler("i", sourceRows),
    support_tickets: filler("t", sourceRows),
  });
}

function readWork(db: FakeConvexDb) {
  return {
    collect: { ...db.stats.collect },
    first: { ...db.stats.first },
    get: { ...db.stats.get },
    documentsReturned: { ...db.stats.documentsReturned },
  };
}

describe("dashboard.stats read work is independent of source table size", () => {
  it("returns counter/aggregate values and never scans source tables", async () => {
    const db = buildDb(5_000);
    const stats = await statsHandler({ db: db as never }, NOW);
    expect(stats).toEqual({
      total_products: 9_001,
      active_products: 8_002,
      total_skus: 7_003,
      total_orders: 6_004,
      orders_today: 12,
      revenue_total: 123_456.78,
      revenue_today: 345.6,
      low_stock_count: 406,
      out_of_stock_count: 307,
      total_customers: 5_005,
      open_tickets: 208,
      active_promotions: 1,
    });
    // No full-table scans: every read is a point lookup or an indexed,
    // fully-constrained bounded take.
    for (const key of Object.keys(db.stats.collect)) {
      expect(key).not.toMatch(
        /^(products|skus|orders|customers|inventory|support_tickets|metricAggregates)$/,
      );
    }
    expect(db.stats.documentsReturned["orders"] ?? 0).toBe(0);
    expect(db.stats.documentsReturned["products"] ?? 0).toBe(0);
    expect(db.stats.documentsReturned["customers"] ?? 0).toBe(0);
  });

  it("does exactly the same read work at 100 rows as at 5,000 rows", async () => {
    const small = buildDb(100);
    const smallStats = await statsHandler({ db: small as never }, NOW);
    const smallRecent = await recentOrdersHandler({ db: small as never }, {});
    const large = buildDb(5_000);
    const largeStats = await statsHandler({ db: large as never }, NOW);
    const largeRecent = await recentOrdersHandler({ db: large as never }, {});

    expect(largeStats).toEqual(smallStats);
    expect(readWork(large)).toEqual(readWork(small));
    expect(largeRecent.length).toBe(smallRecent.length);
    expect(largeRecent.length).toBe(8);
    // recentOrders: one bounded index page + point lookups for that page only.
    expect(large.stats.documentsReturned["orders.by_placed"]).toBe(8);
    expect(large.stats.collect["orders"] ?? 0).toBe(0);
    expect(large.stats.collect["customers"] ?? 0).toBe(0);
    expect(large.stats.collect["stores"] ?? 0).toBe(0);
  });
});
