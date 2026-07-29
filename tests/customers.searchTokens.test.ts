import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler } from "../convex/customers";
import { SEARCH_TOTAL_UNKNOWN } from "../convex/lib/productSearchTokens";
import { customerSearchTokensForText } from "../convex/lib/customerSearchTokens";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

function legacyCustomerRow(
  n: number,
  opts?: { status?: string; name?: string; createdAt?: number },
) {
  const name = opts?.name ?? `Maria Santos ${n}`;
  const row = {
    phone_country_code: "+63",
    phone_number: `91${String(n).padStart(8, "0")}`,
    display_name: name,
    status: (opts?.status ?? "active") as "active",
    marketing_opt_in: false,
    order_count: 0,
    total_spend: 0,
    customerStatsVersion: 2,
    created_at: opts?.createdAt ?? 10_000 + n,
    updated_at: opts?.createdAt ?? 10_000 + n,
  };
  return {
    ...row,
    search_text: `${name.toLowerCase()} +63 ${row.phone_number} +63${row.phone_number}`,
  };
}

async function insertLegacyCustomers(
  t: ReturnType<typeof convexTest>,
  count: number,
  opts?: { createdAt?: (n: number) => number; status?: (n: number) => string },
) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await t.run(async (ctx) => {
      for (let n = start; n < end; n += 1) {
        await ctx.db.insert(
          "customers",
          legacyCustomerRow(n, {
            createdAt: opts?.createdAt?.(n),
            status: opts?.status?.(n),
          }),
        );
      }
    });
  }
}

async function completeSearchMigration(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.customers.backfillCustomerSearchTokens, { limit: 200 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function drainSearch(
  t: ReturnType<typeof convexTest>,
  args: Record<string, unknown>,
  limit: number,
) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    pages += 1;
    expect(pages).toBeLessThan(200);
    const page: any = await t.query(api.customers.list, { ...args, limit, cursor } as never);
    seen.push(...page.data.map((row: any) => row._id as string));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
}

describe("customers.list token search (post-migration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns explicit migration state until the backfill completes", async () => {
    const t = convexTest({ schema, modules });
    await insertLegacyCustomers(t, 3);

    const pending = await t.query(api.customers.list, { search: "maria", limit: 2 });
    expect(pending.searchMigrationPending).toBe(true);
    expect(pending.data).toHaveLength(0);
    expect(pending.totalIsExact).toBe(false);
    expect(pending.total).toBe(SEARCH_TOTAL_UNKNOWN);

    await completeSearchMigration(t);
    const page = await t.query(api.customers.list, { search: "maria", limit: 2 });
    expect(page.searchMigrationPending).toBe(false);
    expect(page.data).toHaveLength(2);
    expect(page.totalIsExact).toBe(false);
    expect(page.hasMore).toBe(true);
  });

  it("keeps match sets larger than 512 pageable instead of scanning", async () => {
    const t = convexTest({ schema, modules });
    await insertLegacyCustomers(t, 600);
    await completeSearchMigration(t);

    const seen = await drainSearch(t, { search: "maria" }, 50);
    expect(seen).toHaveLength(600);
    expect(new Set(seen).size).toBe(600);

    // deterministic newest-first order across the drain
    const timestamps = await t.run(async (ctx) =>
      Promise.all(
        seen.map(async (id) => (await ctx.db.get(id as Id<"customers">))!.created_at),
      ),
    );
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index]).toBeLessThanOrEqual(timestamps[index - 1]);
    }
  });

  it("paginates equal created_at values without gaps or duplicates", async () => {
    const t = convexTest({ schema, modules });
    await insertLegacyCustomers(t, 21, { createdAt: () => 5_000 });
    await completeSearchMigration(t);

    const seen = await drainSearch(t, { search: "maria" }, 4);
    expect(seen).toHaveLength(21);
    expect(new Set(seen).size).toBe(21);
  });

  it("applies the status filter and multi-token queries across pages", async () => {
    const t = convexTest({ schema, modules });
    await insertLegacyCustomers(t, 12, {
      status: (n) => (n % 2 === 0 ? "active" : "blocked"),
    });
    await completeSearchMigration(t);

    const active = await drainSearch(t, { search: "maria", status: "active" }, 2);
    expect(active).toHaveLength(6);

    const multi = await drainSearch(t, { search: "santos maria" }, 50);
    expect(multi).toHaveLength(12);

    const absent = await drainSearch(t, { search: "maria nobody" }, 50);
    expect(absent).toHaveLength(0);
  });

  it("documents versioned token semantics for name and phone", async () => {
    expect(customerSearchTokensForText("juan dela cruz +63 9551234 +639551234")).toEqual(
      ["juan", "dela", "cruz", "63", "9551234", "639551234"],
    );

    const t = convexTest({ schema, modules });
    await insertLegacyCustomers(t, 2);
    await completeSearchMigration(t);

    // full number (with or without country code) matches; prefixes do not
    expect(await drainSearch(t, { search: "9100000000" }, 10)).toHaveLength(1);
    expect(await drainSearch(t, { search: "639100000001" }, 10)).toHaveLength(1);
    expect(await drainSearch(t, { search: "9100000" }, 10)).toHaveLength(0);
    // case-insensitive name tokens, order-independent
    expect(await drainSearch(t, { search: "SANTOS maria" }, 10)).toHaveLength(2);
  });

  it("maintains token rows on create, profile, status, and phone updates", async () => {
    const t = convexTest({ schema, modules });
    await completeSearchMigration(t);

    const id = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9551234",
      display_name: "Tokenwriter",
    });
    let page = await t.query(api.customers.list, { search: "tokenwriter", limit: 5 });
    expect(page.data.map((row) => row._id)).toEqual([id]);

    await t.mutation(api.customers.updateProfile, { id, display_name: "Renamed" });
    page = await t.query(api.customers.list, { search: "tokenwriter", limit: 5 });
    expect(page.data).toHaveLength(0);
    page = await t.query(api.customers.list, { search: "renamed", limit: 5 });
    expect(page.data).toHaveLength(1);

    await t.mutation(api.customers.setStatus, { id, status: "blocked" });
    page = await t.query(api.customers.list, { search: "renamed", status: "active", limit: 5 });
    expect(page.data).toHaveLength(0);
    page = await t.query(api.customers.list, { search: "renamed", status: "blocked", limit: 5 });
    expect(page.data).toHaveLength(1);

    await t.mutation(api.customers.updatePhone, { id, phone_number: "9669876" });
    page = await t.query(api.customers.list, { search: "9669876", limit: 5 });
    expect(page.data).toHaveLength(1);
    page = await t.query(api.customers.list, { search: "9551234", limit: 5 });
    expect(page.data).toHaveLength(0);
  });
});

describe("customers.list token search read bounds", () => {
  function catalog(matchCount: number, unrelatedCount: number, migrated = true) {
    const matches = Array.from({ length: matchCount }, (_, index) =>
      doc("customers", {
        _id: `match_${index}`,
        phone_country_code: "+63",
        phone_number: `91${index}`,
        display_name: `Maria ${index}`,
        status: "active",
        marketing_opt_in: false,
        order_count: 0,
        total_spend: 0,
        customerStatsVersion: 2,
        created_at: 10_000 + index,
        updated_at: 10_000 + index,
      }),
    );
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) =>
      doc("customers", {
        _id: `other_${index}`,
        phone_country_code: "+63",
        phone_number: `92${index}`,
        display_name: `Juan ${index}`,
        status: "blocked",
        marketing_opt_in: false,
        order_count: 0,
        total_spend: 0,
        customerStatsVersion: 2,
        created_at: index,
        updated_at: index,
      }),
    );
    return new FakeConvexDb({
      customers: [...matches, ...unrelated],
      customerSearchTokens: matches.map((row) =>
        doc("customerSearchTokens", {
          _id: `tok_${row._id}`,
          customer_id: row._id,
          token: "maria",
          tokens: ["maria"],
          created_at: row.created_at,
          status: "active",
        }),
      ),
      transitionState: migrated
        ? [
            doc("transitionState", {
              _id: "ts_customer_search",
              key: "customerSearchTokens",
              complete: true,
            }),
          ]
        : [],
      listCounts: [],
    });
  }

  it("keeps search page reads constant while matching and unrelated customers grow", async () => {
    const snapshots: Record<string, unknown>[] = [];
    for (const [matchCount, unrelatedCount] of [
      [300, 50],
      [2_000, 2_000],
    ]) {
      const db = catalog(matchCount, unrelatedCount);
      const result = await listHandler({ db }, { search: "maria", limit: 10 });
      expect(result.data).toHaveLength(10);
      expect(result.totalIsExact).toBe(false);
      expect(result.total).toBe(SEARCH_TOTAL_UNKNOWN);
      expect(result.hasMore).toBe(true);
      snapshots.push({
        tokenDocs:
          db.stats.documentsReturned["customerSearchTokens.by_token_created"] ?? 0,
        customerGets: db.stats.get.customers ?? 0,
        searchIndexDocs:
          db.stats.documentsReturned["customers.search:search_customers"] ?? 0,
        customerIndexDocs: db.stats.documentsReturned["customers.by_created"] ?? 0,
      });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].tokenDocs).toBeLessThanOrEqual(10);
    expect(snapshots[0].customerGets).toBeLessThanOrEqual(10);
    expect(snapshots[0].searchIndexDocs).toBe(0);
    expect(snapshots[0].customerIndexDocs).toBe(0);
  });

  it("search before migration performs no match-set reads and reports pending state", async () => {
    const db = catalog(20, 50, false);
    const result = await listHandler({ db }, { search: "maria", limit: 5 });
    expect(result.searchMigrationPending).toBe(true);
    expect(result.totalIsExact).toBe(false);
    expect(result.total).toBe(SEARCH_TOTAL_UNKNOWN);
    expect(result.data).toHaveLength(0);
    expect(db.stats.documentsReturned["customers.search:search_customers"]).toBeUndefined();
    expect(db.stats.documentsReturned["customerSearchTokens.by_token_created"]).toBeUndefined();
    expect(db.stats.collect.customers).toBeUndefined();
  });
});
