import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { SEARCH_TOTAL_UNKNOWN } from "../convex/lib/productSearchTokens";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedStoreAndCategory(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
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
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: "cat",
      sort_order: 1,
      is_active: true,
    });
    const brandId = await ctx.db.insert("brands", {
      name: "Brand",
      is_active: true,
    });
    return { storeId, categoryId, brandId };
  });
}

describe("list response contracts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("customers.list returns exact totals maintained by public mutations", async () => {
    const t = convexTest({ schema, modules });
    const first = await t.query(api.customers.list, { limit: 10 });
    expect(first).toMatchObject({ total: 0, totalIsExact: true, hasMore: false });
    expect(first.data).toHaveLength(0);

    const a = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9100000001",
      display_name: "Alice",
    });
    const b = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9100000002",
      display_name: "Bob",
      status: "guest",
    });

    let page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(2);
    page = await t.query(api.customers.list, { status: "guest", limit: 10 });
    expect(page.total).toBe(1);
    expect(page.data[0]._id).toBe(b);

    await t.mutation(api.customers.setStatus, { id: a, status: "blocked" });
    page = await t.query(api.customers.list, { status: "active", limit: 10 });
    expect(page.total).toBe(0);
    page = await t.query(api.customers.list, { status: "blocked", limit: 10 });
    expect(page.total).toBe(1);
    page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(2);

    // flip search to the versioned token-stream path (writers already
    // maintained token rows; the backfill only records completion)
    await t.mutation(internal.customers.backfillCustomerSearchTokens, { limit: 200 });

    // search totals are explicitly non-exact under the versioned contract
    page = await t.query(api.customers.list, { search: "alice", limit: 10 });
    expect(page.totalIsExact).toBe(false);
    expect(page.total).toBe(SEARCH_TOTAL_UNKNOWN);
    expect(page.data).toHaveLength(1);
    page = await t.query(api.customers.list, {
      search: "9100000001",
      limit: 10,
    });
    expect(page.totalIsExact).toBe(false);
    expect(page.data).toHaveLength(1);
    // full concatenated number is itself a token
    page = await t.query(api.customers.list, {
      search: "639100000002",
      limit: 10,
    });
    expect(page.data).toHaveLength(1);
    page = await t.query(api.customers.list, {
      search: "nothing-matches",
      limit: 10,
    });
    expect(page).toMatchObject({ total: SEARCH_TOTAL_UNKNOWN, hasMore: false });
    expect(page.data).toHaveLength(0);
    // intentional versioned change: no prefix matching on partial numbers
    page = await t.query(api.customers.list, {
      search: "910000000",
      limit: 10,
    });
    expect(page.data).toHaveLength(0);
  });

  it("orders.list returns exact totals for status, store, search, and windows", async () => {
    const t = convexTest({ schema, modules });
    const { storeId } = await seedStoreAndCategory(t);
    const customerId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9100000010",
      display_name: "Buyer",
    });
    const addressId = await t.run(async (ctx) =>
      ctx.db.insert("addresses", {
        customer_id: customerId,
        label: "home",
        title: "H",
        full_address: "H",
        country_code: "PH",
        latitude: 0,
        longitude: 0,
        is_default: true,
        created_at: 1,
        updated_at: 1,
      }),
    );
    const mkOrder = (n: number, status?: "confirmed" | "cancelled") =>
      t.mutation(api.orders.create, {
        order_number: `PM-TOTAL-${n}`,
        customer_id: customerId,
        store_id: storeId,
        address_id: addressId,
        delivery_mode: "express",
        status: status ?? "confirmed",
        payment_status: "paid",
        subtotal_amount: 1,
        total_amount: 1,
        placed_at: 1_000 * (n + 1),
      });
    for (let index = 0; index < 7; index += 1) await mkOrder(index);
    await t.mutation(api.orders.updateStatus, {
      id: await mkOrder(7),
      status: "cancelled",
    });

    let page = await t.query(api.orders.list, { limit: 3 });
    expect(page.total).toBe(8);
    expect(page.data).toHaveLength(3);
    const page2 = await t.query(api.orders.list, {
      limit: 3,
      cursor: page.nextCursor,
    });
    expect(page2.total).toBe(8);
    expect(page2.data).toHaveLength(3);

    page = await t.query(api.orders.list, { status: "cancelled", limit: 10 });
    expect(page.total).toBe(1);
    page = await t.query(api.orders.list, {
      store_id: storeId,
      status: "confirmed",
      limit: 10,
    });
    expect(page.total).toBe(7);
    page = await t.query(api.orders.list, { search: "pm-total", limit: 10 });
    expect(page.total).toBe(8);
    page = await t.query(api.orders.list, {
      placed_from: 3_000,
      placed_to: 5_000,
      limit: 10,
    });
    expect(page.total).toBe(3);
    page = await t.query(api.orders.list, {
      search: "pm-total",
      placed_from: 3_000,
      placed_to: 5_000,
      limit: 10,
    });
    expect(page.total).toBe(3);
    page = await t.query(api.orders.list, { search: "zzz", limit: 10 });
    expect(page).toMatchObject({ total: 0, hasMore: false });

    // deletion decrements maintained counters
    const doomed = await mkOrder(8);
    await t.mutation(api.orders.remove, { id: doomed });
    page = await t.query(api.orders.list, { limit: 10 });
    expect(page.total).toBe(8);
  });

  it("products.list returns exact totals for non-search filters and versioned non-exact search semantics", async () => {
    const t = convexTest({ schema, modules });
    const { categoryId, brandId } = await seedStoreAndCategory(t);
    const otherCategory = await t.run(async (ctx) =>
      ctx.db.insert("categories", {
        name: "Other Cat",
        slug: "other-cat",
        sort_order: 2,
        is_active: true,
      }),
    );
    const mk = (
      n: number,
      opts: { category?: Id<"categories">; brand?: Id<"brands">; status?: "active" | "draft" },
    ) =>
      t.mutation(api.products.create, {
        primary_category_id: opts.category ?? categoryId,
        brand_id: opts.brand,
        name: `Contract Product ${n}`,
        status: opts.status ?? "active",
      });
    await mk(0, { brand: brandId });
    await mk(1, { brand: brandId, status: "draft" });
    await mk(2, { category: otherCategory });
    // Flip search to the versioned token-stream path (writers already
    // maintained token rows; the backfill only records completion).
    await t.mutation(internal.products.backfillProductSearchTokens, { limit: 200 });

    const cases: Array<[Record<string, unknown>, number]> = [
      [{}, 3],
      [{ status: "active" }, 2],
      [{ status: "draft" }, 1],
      [{ category_id: categoryId }, 2],
      [{ category_id: otherCategory }, 1],
      [{ brand_id: brandId }, 2],
      [{ status: "active", category_id: categoryId }, 1],
      [{ status: "draft", category_id: categoryId }, 1],
      [{ status: "active", brand_id: brandId }, 1],
      [{ category_id: categoryId, brand_id: brandId }, 2],
      [
        {
          status: "active",
          category_id: categoryId,
          brand_id: brandId,
        },
        1,
      ],
      [{ search: "contract" }, 3],
      [{ search: "contract", status: "draft" }, 1],
      [{ search: "contract", category_id: otherCategory }, 1],
      [{ search: "missing" }, 0],
    ];
    for (const [args, expected] of cases) {
      const page = await t.query(api.products.list, { ...args, limit: 10 } as never);
      const isSearch = typeof args.search === "string";
      expect(page.totalIsExact, JSON.stringify(args)).toBe(!isSearch);
      expect(page.total, JSON.stringify(args)).toBe(
        isSearch ? SEARCH_TOTAL_UNKNOWN : expected,
      );
      expect(page.data, JSON.stringify(args)).toHaveLength(expected);
    }

    // status change moves the counters
    const draftPage = await t.query(api.products.list, {
      status: "draft",
      limit: 10,
    });
    const draftId = draftPage.data[0]._id;
    await t.mutation(api.products.update, { id: draftId, status: "active" });
    const activePage = await t.query(api.products.list, {
      status: "active",
      limit: 10,
    });
    expect(activePage.total).toBe(3);
  });

  it("reconcileListCounts repairs drifted counters and drops stale rows", async () => {
    const t = convexTest({ schema, modules });
    await seedStoreAndCategory(t);
    const customerId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9100000020",
    });
    void customerId;
    // corrupt counters: wrong count + a stale row
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("listCounts")
        .withIndex("by_scope_key", (q) =>
          q.eq("scope", "customers").eq("key", "all"),
        )
        .first();
      await ctx.db.patch(row!._id, { count: 999 });
      await ctx.db.insert("listCounts", {
        scope: "customers",
        key: "status:nonexistent",
        count: 5,
      });
    });
    let page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(999);

    let done = false;
    let cursor: string | undefined;
    let guard = 0;
    while (!done) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "customers",
        cursor,
      });
      done = result.done;
      cursor = done ? undefined : (result as { nextCursor?: string }).nextCursor;
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(1);
    page = await t.query(api.customers.list, {
      status: "active",
      limit: 10,
    });
    expect(page.total).toBe(1);
    const stale = await t.run(async (ctx) =>
      ctx.db
        .query("listCounts")
        .withIndex("by_scope_key", (q) =>
          q.eq("scope", "customers").eq("key", "status:nonexistent"),
        )
        .first(),
    );
    expect(stale).toBeNull();
  });
});
