import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { ORDER_LIST_SCAN_CAP } from "../convex/orders";

const modules = import.meta.glob("../convex/**/*.ts");

const CAP = ORDER_LIST_SCAN_CAP;

async function seedEnv(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", {
      phone_country_code: "+63",
      phone_number: "900",
      display_name: "V2 Customer",
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
  opts?: { placedAt?: number; searchText?: string; version?: number },
) {
  const row: Record<string, unknown> = {
    order_number: `PM-V2-${n}`,
    customer_id: env.customerId,
    store_id: env.storeId,
    address_id: env.addressId,
    delivery_mode: "express",
    status: "confirmed",
    payment_status: "paid",
    currency: "PHP",
    subtotal_amount: 1,
    discount_amount: 0,
    delivery_fee_amount: 0,
    total_amount: 1,
    item_count: 0,
    order_search_text: opts?.searchText ?? `pm-v2-${n} v2 customer +63 900 +63900`,
    orderSummaryVersion: opts?.version ?? 2,
    placed_at: opts?.placedAt ?? 10_000 + n,
  };
  if (opts?.version === -1) delete row.orderSummaryVersion;
  return row;
}

async function insertOrders(
  t: ReturnType<typeof convexTest>,
  env: Awaited<ReturnType<typeof seedEnv>>,
  count: number,
  opts?: { placedAt?: (n: number) => number; searchText?: (n: number) => string; version?: number },
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
            version: opts?.version,
          }) as never,
        );
      }
    });
  }
}

describe("orders.listV2 contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches orders.list on first page, total, and response shape", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 9);

    const legacy = await t.query(api.orders.list, { limit: 4 });
    const v2 = await t.query(api.orders.listV2, { limit: 4 });
    expect(v2.data.map((row) => row._id)).toEqual(
      legacy.data.map((row) => row._id),
    );
    expect(v2.total).toBe(legacy.total);
    expect(v2).toMatchObject({
      total: 9,
      totalIsExact: true,
      limit: 4,
      offset: 0,
      hasMore: true,
    });
    expect(typeof v2.nextCursor).toBe("string");

    // Same compatibility under filters and search.
    const legacySearch = await t.query(api.orders.list, {
      search: "v2 customer",
      status: "confirmed",
      store_id: env.storeId,
      placed_from: 10_000,
      placed_to: 10_004,
      limit: 3,
    });
    const v2Search = await t.query(api.orders.listV2, {
      search: "v2 customer",
      status: "confirmed",
      store_id: env.storeId,
      placed_from: 10_000,
      placed_to: 10_004,
      limit: 3,
    });
    expect(v2Search.data.map((row) => row._id)).toEqual(
      legacySearch.data.map((row) => row._id),
    );
    expect(v2Search.total).toBe(legacySearch.total);
  });

  it("does not accept legacy offset arguments", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t);
    await expect(
      t.query(api.orders.listV2, { limit: 5, offset: 0 } as never),
    ).rejects.toThrow();
  });

  it("paginates the full result set through filter-fingerprinted cursors", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 11, { placedAt: () => 5_000 });

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const page = await t.query(api.orders.listV2, { limit: 4, cursor });
      expect(page.total).toBe(11);
      seen.push(...page.data.map((row) => row._id as string));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(new Set(seen).size).toBe(11);

    // Fingerprint mismatch: same cursor against a different filter fails.
    const first = await t.query(api.orders.listV2, {
      status: "confirmed",
      limit: 4,
    });
    await expect(
      t.query(api.orders.listV2, {
        status: "cancelled",
        limit: 4,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects search/date domains above the scan cap explicitly", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, CAP + 1, {
      searchText: (n) => `needle v2 ${n}`,
      placedAt: (n) => 5_000 + n,
    });
    await expect(
      t.query(api.orders.listV2, { search: "needle", limit: 10 }),
    ).rejects.toThrow(/narrow the search term/);
    await expect(
      t.query(api.orders.listV2, {
        placed_from: 5_000,
        placed_to: 6_000,
        limit: 10,
      }),
    ).rejects.toThrow(/date window/);
  });

  it("returns an empty page for empty domains", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 3);
    const page = await t.query(api.orders.listV2, {
      search: "absent",
      limit: 5,
    });
    expect(page).toMatchObject({ total: 0, hasMore: false, nextCursor: null });
    expect(page.data).toHaveLength(0);
  });
});

describe("orders rollout drill (docs/orders-list-rollout.md)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gates the list until counters and summaries are repaired, then serves it", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    // Legacy state: direct inserts with no listCounts rows and no summary
    // versions (version -1 strips the field).
    await insertOrders(t, env, 7, { version: -1 });

    // Gate: the list refuses to serve unrepaired data.
    await expect(t.query(api.orders.listV2, { limit: 3 })).rejects.toThrow(
      /backfillOrderListSummaries/,
    );

    // Step 1: rebuild counters until drained.
    let countersDone = false;
    let counterCursor: string | undefined;
    let guard = 0;
    while (!countersDone) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "orders",
        cursor: counterCursor,
      });
      countersDone = result.done;
      counterCursor = result.done
        ? undefined
        : (result as { nextCursor?: string }).nextCursor;
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Step 2: backfill summaries until drained.
    let summariesDone = false;
    let summaryCursor: string | undefined;
    guard = 0;
    while (!summariesDone) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.orders.backfillOrderListSummaries, {
        limit: 3,
        cursor: summaryCursor,
      });
      summariesDone = !result.remainingMayExist;
      summaryCursor = result.remainingMayExist
        ? (result.nextCursor ?? undefined)
        : undefined;
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Step 3: readiness gate must pass.
    const readiness = await t.query(internal.orders.orderSummaryReadiness, {});
    expect(readiness).toMatchObject({ stale: 0, ready: true, overflow: false });

    // Step 4: full reconciliation sweep, then a proving second sweep.
    const sweep = async () => {
      let done = false;
      let cursor: string | undefined;
      let patched = 0;
      let sweepGuard = 0;
      while (!done) {
        sweepGuard += 1;
        expect(sweepGuard).toBeLessThan(10);
        const result = await t.mutation(internal.orders.reconcileOrderSummaries, {
          limit: 3,
          cursor,
        });
        patched += result.patched;
        done = result.done;
        cursor = result.nextCursor;
      }
      return patched;
    };
    const firstSweepPatched = await sweep();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const secondSweepPatched = await sweep();
    expect(secondSweepPatched).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    void firstSweepPatched;

    // Step 5: the list now serves exact, newest-first pages.
    const page = await t.query(api.orders.listV2, { limit: 3 });
    expect(page).toMatchObject({ total: 7, totalIsExact: true, hasMore: true });
    expect(page.data).toHaveLength(3);
    const placed = page.data.map((row) => row.placed_at);
    expect(placed).toEqual([...placed].sort((a, b) => b - a));
    const legacy = await t.query(api.orders.list, { limit: 3 });
    expect(legacy.data.map((row) => row._id)).toEqual(
      page.data.map((row) => row._id),
    );
  });

  it("survives rollout retries: re-running every step is idempotent", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t);
    await insertOrders(t, env, 4, { version: -1 });

    const runAll = async () => {
      await t.mutation(internal.listCounts.reconcileListCounts, { scope: "orders" });
      await t.mutation(internal.orders.backfillOrderListSummaries, { limit: 100 });
      await t.mutation(internal.orders.reconcileOrderSummaries, { limit: 100 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    };
    await runAll();
    const first = await t.query(api.orders.listV2, { limit: 2 });
    // Simulated crash-recovery: run the whole rollout again.
    await runAll();
    const second = await t.query(api.orders.listV2, { limit: 2 });
    expect(second.total).toBe(first.total);
    expect(second.data.map((row) => row._id)).toEqual(
      first.data.map((row) => row._id),
    );
    const readiness = await t.query(internal.orders.orderSummaryReadiness, {});
    expect(readiness.ready).toBe(true);
  });
});
