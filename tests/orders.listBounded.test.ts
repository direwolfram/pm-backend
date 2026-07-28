import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler, ORDER_LIST_SCAN_CAP } from "../convex/orders";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

const CAP = ORDER_LIST_SCAN_CAP;

async function seedEnv(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", {
      phone_country_code: "+63",
      phone_number: "900",
      display_name: "Bounded Customer",
      status: "active",
      marketing_opt_in: false,
      created_at: 1,
      updated_at: 1,
    });
    const storeId = await ctx.db.insert("stores", {
      name: "Store",
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
    return { customerId, storeId, addressId };
  });
}

function orderRow(
  env: { customerId: Id<"customers">; storeId: Id<"stores">; addressId: Id<"addresses"> },
  n: number,
  opts?: { placedAt?: number; searchText?: string; status?: string; version?: number; itemCount?: number },
) {
  return {
    order_number: `PM-BND-${n}`,
    customer_id: env.customerId,
    store_id: env.storeId,
    address_id: env.addressId,
    delivery_mode: "express" as const,
    status: opts?.status ?? "confirmed",
    payment_status: "paid" as const,
    currency: "PHP",
    subtotal_amount: 1,
    discount_amount: 0,
    delivery_fee_amount: 0,
    total_amount: 1,
    item_count: opts?.itemCount ?? 0,
    order_search_text: opts?.searchText ?? `pm-bnd-${n} bounded customer +63 900 +63900`,
    orderSummaryVersion: opts?.version ?? 2,
    placed_at: opts?.placedAt ?? 10_000 + n,
  };
}

async function insertOrders(
  t: ReturnType<typeof convexTest>,
  env: Awaited<ReturnType<typeof seedEnv>>,
  count: number,
  opts?: { placedAt?: (n: number) => number; searchText?: (n: number) => string },
) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await t.run(async (ctx) => {
      for (let n = start; n < end; n += 1) {
        await ctx.db.insert(
          "orders",
          orderRow(env, n, {
            placedAt: opts?.placedAt?.(n),
            searchText: opts?.searchText?.(n),
          }),
        );
      }
    });
  }
}

describe("orders.list bounded scan caps", () => {
  it("rejects search domains larger than the scan cap instead of truncating", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, CAP + 1, {
      searchText: (n) => `needle order ${n}`,
    });

    await expect(
      t.query(api.orders.list, { search: "needle", limit: 10 }),
    ).rejects.toThrow(/narrow the search term/);
    // A date window cannot rescue an over-cap raw match set: the unread
    // tail could contain in-window results, so rejection stays explicit.
    await expect(
      t.query(api.orders.list, {
        search: "needle",
        placed_from: 10_000,
        placed_to: 10_001,
        limit: 10,
      }),
    ).rejects.toThrow(/narrow the search term/);
    // A narrow term that stays under the cap still works.
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "orders",
        orderRow(env, 99_999, { searchText: "raretoken order" }),
      );
    });
    const page = await t.query(api.orders.list, {
      search: "raretoken",
      limit: 10,
    });
    expect(page.total).toBe(1);
    expect(page.data[0].order_number).toBe("PM-BND-99999");
  });

  it("rejects date-window totals larger than the scan cap", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, CAP + 1, { placedAt: (n) => 5_000 + n });

    await expect(
      t.query(api.orders.list, {
        placed_from: 5_000,
        placed_to: 6_000,
        limit: 10,
      }),
    ).rejects.toThrow(/date window/);

    const narrow = await t.query(api.orders.list, {
      placed_from: 5_000,
      placed_to: 5_009,
      limit: 10,
    });
    expect(narrow.total).toBe(10);
    expect(narrow.totalIsExact).toBe(true);
  });

  it("never falls back to an unbounded scan when counters are missing", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      const env = await seedEnv(t);
      await insertOrders(t, env, CAP + 1);

      // No listCounts rows exist (direct inserts bypass the mutations), so the
      // equality-filtered query must reject rather than full-scan.
      await expect(t.query(api.orders.list, { limit: 10 })).rejects.toThrow(
        /reconcileListCounts/,
      );

      // Rollout path: rebuild the counters, then the same query is O(1) exact.
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
        done = result.done;
        cursor = done ? undefined : (result as { nextCursor?: string }).nextCursor;
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const page = await t.query(api.orders.list, { limit: 10 });
      expect(page.total).toBe(CAP + 1);
      expect(page.totalIsExact).toBe(true);
      expect(page.data).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts small counter-less domains exactly within the cap", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 7);
    const page = await t.query(api.orders.list, { limit: 3 });
    expect(page.total).toBe(7);
    expect(page.totalIsExact).toBe(true);
  });
});

describe("orders.list boundary and edge semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats placed_from and placed_to as inclusive bounds", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await t.run(async (ctx) => {
      for (const placedAt of [1_000, 2_000, 3_000]) {
        await ctx.db.insert("orders", orderRow(env, placedAt, { placedAt }));
      }
    });

    const both = await t.query(api.orders.list, {
      placed_from: 1_000,
      placed_to: 3_000,
      limit: 10,
    });
    expect(both.total).toBe(3);
    const fromOnly = await t.query(api.orders.list, {
      placed_from: 1_001,
      limit: 10,
    });
    expect(fromOnly.total).toBe(2);
    const toOnly = await t.query(api.orders.list, {
      placed_to: 2_999,
      limit: 10,
    });
    expect(toOnly.total).toBe(2);
    const empty = await t.query(api.orders.list, {
      placed_from: 1_001,
      placed_to: 1_999,
      limit: 10,
    });
    expect(empty).toMatchObject({
      total: 0,
      hasMore: false,
      nextCursor: null,
    });
    expect(empty.data).toHaveLength(0);
  });

  it("caps oversized limits at the maximum page size", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 3);
    const page = await t.query(api.orders.list, { limit: 1_000 });
    expect(page.limit).toBe(200);
    expect(page.total).toBe(3);
  });

  it("enriches rows whose customer or store reference is missing", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await t.run(async (ctx) => {
      const ghostCustomer = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "000",
        status: "active",
        marketing_opt_in: false,
        created_at: 1,
        updated_at: 1,
      });
      const ghostStore = await ctx.db.insert("stores", {
        name: "Ghost Store",
        status: "active",
        address: "G",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: 1,
        updated_at: 1,
      });
      const orderId = await ctx.db.insert("orders", {
        ...orderRow(env, 1),
        customer_id: ghostCustomer,
        store_id: ghostStore,
        item_count: undefined,
        order_search_text: "ghost order",
      });
      await ctx.db.delete(ghostCustomer);
      await ctx.db.delete(ghostStore);
      void orderId;
    });
    const page = await t.query(api.orders.list, { search: "ghost", limit: 10 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].customer_name).toBe("");
    expect(page.data[0].store_name).toBeUndefined();
    expect(page.data[0].item_count).toBe(0);
  });

  it("reflects writes immediately on re-query (reactive invalidation)", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    const before = await t.query(api.orders.list, { limit: 10 });
    expect(before.total).toBe(0);

    const id = await t.mutation(api.orders.create, {
      order_number: "PM-REACTIVE-1",
      customer_id: env.customerId,
      store_id: env.storeId,
      address_id: env.addressId,
      delivery_mode: "express",
      status: "confirmed",
      payment_status: "paid",
      subtotal_amount: 5,
      total_amount: 5,
      placed_at: 42_000,
    });
    let page = await t.query(api.orders.list, { limit: 10 });
    expect(page.total).toBe(1);
    expect(page.data[0]._id).toBe(id);

    await t.mutation(api.orders.updateStatus, { id, status: "cancelled" });
    page = await t.query(api.orders.list, { status: "confirmed", limit: 10 });
    expect(page.total).toBe(0);
    page = await t.query(api.orders.list, { status: "cancelled", limit: 10 });
    expect(page.total).toBe(1);

    await t.mutation(api.orders.remove, { id });
    page = await t.query(api.orders.list, { limit: 10 });
    expect(page.total).toBe(0);
  });
});

describe("order summary readiness and reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports readiness and becomes ready after the backfill", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("orders", orderRow(env, 1));
      await ctx.db.insert("orders", {
        ...orderRow(env, 2),
        orderSummaryVersion: 1,
      });
      const stale = orderRow(env, 3) as Record<string, unknown>;
      delete stale.orderSummaryVersion;
      await ctx.db.insert("orders", stale);
    });

    let readiness = await t.query(internal.orders.orderSummaryReadiness, {});
    expect(readiness).toMatchObject({ stale: 2, ready: false, overflow: false });

    await t.mutation(internal.orders.backfillOrderListSummaries, { limit: 100 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    readiness = await t.query(internal.orders.orderSummaryReadiness, {});
    expect(readiness).toMatchObject({ stale: 0, ready: true });
  });

  it("threads backfill continuation, retries safely, and is idempotent", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await t.run(async (ctx) => {
      for (let n = 0; n < 3; n += 1) {
        await ctx.db.insert("orders", {
          ...orderRow(env, n),
          orderSummaryVersion: 1,
          order_search_text: "stale",
        });
      }
    });

    let cursor: string | undefined;
    const patchedPerRun: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      const result = await t.mutation(internal.orders.backfillOrderListSummaries, {
        limit: 1,
        cursor,
      });
      patchedPerRun.push(result.patched);
      if (!result.remainingMayExist) break;
      cursor = result.nextCursor ?? undefined;
    }
    expect(patchedPerRun).toEqual([1, 1, 1]);

    // Retrying the final continuation is a no-op.
    const retry = await t.mutation(internal.orders.backfillOrderListSummaries, {
      limit: 1,
      cursor,
    });
    expect(retry.patched).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("full-sweep reconcile repairs stale rows that carry the current version", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    const corruptId = await t.run(async (ctx) => {
      // Correct version but wrong text/count: invisible to the
      // version-targeted backfill by design.
      return await ctx.db.insert("orders", {
        ...orderRow(env, 1),
        item_count: 99,
        order_search_text: "corrupt text",
        orderSummaryVersion: 2,
      });
    });
    await insertOrders(t, env, 2, { placedAt: (n) => 20_000 + n });

    const targeted = await t.mutation(internal.orders.backfillOrderListSummaries, {
      limit: 100,
    });
    expect(targeted.processed).toBe(0);

    let done = false;
    let cursor: string | undefined;
    let patched = 0;
    let guard = 0;
    while (!done) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.orders.reconcileOrderSummaries, {
        limit: 1,
        cursor,
      });
      patched += result.patched;
      done = result.done;
      cursor = result.nextCursor;
    }
    expect(patched).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const repaired = await t.run(async (ctx) => await ctx.db.get(corruptId));
    expect(repaired?.order_search_text).toContain("bounded customer");
    expect(repaired?.item_count).toBe(0);

    const again = await t.mutation(internal.orders.reconcileOrderSummaries, {
      limit: 100,
    });
    expect(again.patched).toBe(0);
  });
});

function fakeOrder(
  id: string,
  opts: {
    storeId?: string;
    customerId?: string;
    placedAt: number;
    searchText?: string;
    status?: string;
  },
) {
  return doc("orders", {
    _id: id,
    order_number: `PM-${id}`,
    customer_id: opts.customerId ?? "customer_shared",
    store_id: opts.storeId ?? "store_a",
    address_id: "addr",
    delivery_mode: "express",
    status: opts.status ?? "confirmed",
    payment_status: "paid",
    currency: "PHP",
    subtotal_amount: 100,
    discount_amount: 0,
    delivery_fee_amount: 0,
    total_amount: 100,
    item_count: 2,
    order_search_text:
      opts.searchText ?? `pm-${id} shared customer`.toLowerCase(),
    orderSummaryVersion: 2,
    placed_at: opts.placedAt,
  });
}

function fakeDbWithHistory(inWindow: number, outOfWindow: number) {
  const target = Array.from({ length: inWindow }, (_, index) =>
    fakeOrder(`in_${index}`, { placedAt: 5_000 + index }),
  );
  const unrelated = Array.from({ length: outOfWindow }, (_, index) =>
    fakeOrder(`out_${index}`, {
      placedAt: 900_000 + index,
      storeId: "store_b",
      customerId: `other_${index}`,
      searchText: `haystack ${index}`,
      status: "cancelled",
    }),
  );
  return new FakeConvexDb({
    orders: [...target, ...unrelated],
    customers: [
      doc("customers", {
        _id: "customer_shared",
        phone_country_code: "+63",
        phone_number: "900",
        display_name: "Shared Customer",
        status: "active",
        marketing_opt_in: false,
        created_at: 1,
        updated_at: 1,
      }),
    ],
    stores: [
      doc("stores", {
        _id: "store_a",
        name: "Store A",
        status: "active",
        address: "A",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: 1,
        updated_at: 1,
      }),
    ],
  });
}

describe("orders.list read bounds as history grows", () => {
  it("keeps windowed page and total reads constant as out-of-window history grows", async () => {
    const reads: number[] = [];
    for (const outOfWindow of [100, 2_000]) {
      const db = fakeDbWithHistory(8, outOfWindow);
      const result = await listHandler(
        { db },
        { placed_from: 5_000, placed_to: 5_007, limit: 5 },
      );
      expect(result.total).toBe(8);
      expect(result.data).toHaveLength(5);
      expect(db.stats.collect.orders).toBeUndefined();
      reads.push(db.stats.documentsReturned["orders.by_placed"] ?? 0);
    }
    expect(reads[0]).toBe(reads[1]);
    // window count (8) + one page (5)
    expect(reads[0]).toBeLessThanOrEqual(13);
  });

  it("keeps search reads proportional to the match set, not the table", async () => {
    const reads: number[] = [];
    for (const outOfWindow of [100, 2_000]) {
      const db = fakeDbWithHistory(30, outOfWindow);
      const result = await listHandler(
        { db },
        { search: "shared customer", limit: 5 },
      );
      expect(result.total).toBe(30);
      expect(result.data).toHaveLength(5);
      expect(db.stats.collect.orders).toBeUndefined();
      reads.push(
        db.stats.documentsReturned["orders.search:search_orders"] ?? 0,
      );
    }
    expect(reads[0]).toBe(30);
    expect(reads[1]).toBe(30);
  });

  it("rejects over-cap search match sets without scanning further", async () => {
    const db = fakeDbWithHistory(CAP + 1, 0);
    await expect(
      listHandler({ db }, { search: "shared customer", limit: 5 }),
    ).rejects.toThrow(/narrow the search term/);
    expect(
      db.stats.documentsReturned["orders.search:search_orders"],
    ).toBeLessThanOrEqual(CAP + 1);
  });

  it("deduplicates enrichment lookups within a page", async () => {
    const db = fakeDbWithHistory(10, 0);
    const result = await listHandler({ db }, { limit: 5 });
    expect(result.data).toHaveLength(5);
    expect(result.data[0].customer_name).toBe("Shared Customer");
    expect(result.data[0].store_name).toBe("Store A");
    expect(db.stats.get.customers).toBe(1);
    expect(db.stats.get.stores).toBe(1);
    expect(db.stats.collect.order_items).toBeUndefined();
  });
});
