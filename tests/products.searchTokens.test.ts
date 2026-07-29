import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler } from "../convex/products";
import {
  SEARCH_TOTAL_UNKNOWN,
  searchTokensForName,
} from "../convex/lib/productSearchTokens";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedBase(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    });
    const brandId = await ctx.db.insert("brands", {
      name: "Brand",
      is_active: true,
    });
    return { categoryId, brandId };
  });
}

function legacyProductRow(
  env: { categoryId: Id<"categories">; brandId: Id<"brands"> },
  n: number,
  opts?: { updatedAt?: number; status?: string; name?: string },
) {
  return {
    primary_category_id: env.categoryId,
    brand_id: env.brandId,
    name: opts?.name ?? `Needle Product ${n}`,
    slug: `needle-${n}-${Math.random()}`,
    status: (opts?.status ?? "active") as "active",
    rating_average: 0,
    rating_count: 0,
    sku_count: 0,
    total_stock: 0,
    productListSummaryVersion: 2,
    attributes: [],
    created_at: 1,
    updated_at: opts?.updatedAt ?? 10_000 + n,
  };
}

async function insertLegacyProducts(
  t: ReturnType<typeof convexTest>,
  env: Awaited<ReturnType<typeof seedBase>>,
  count: number,
  opts?: { updatedAt?: (n: number) => number; name?: (n: number) => string; status?: (n: number) => string },
) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await t.run(async (ctx) => {
      for (let n = start; n < end; n += 1) {
        await ctx.db.insert(
          "products",
          legacyProductRow(env, n, {
            updatedAt: opts?.updatedAt?.(n),
            name: opts?.name?.(n),
            status: opts?.status?.(n),
          }),
        );
      }
    });
  }
}

async function completeSearchMigration(t: ReturnType<typeof convexTest>) {
  const first = await t.mutation(internal.products.backfillProductSearchTokens, {
    limit: 200,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return first;
}

async function drainSearch(
  t: ReturnType<typeof convexTest>,
  args: Record<string, unknown>,
  limit: number,
) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let lastPage: any;
  do {
    pages += 1;
    expect(pages).toBeLessThan(100);
    const page: any = await t.query(api.products.listV2, { ...args, limit, cursor } as never);
    seen.push(...page.data.map((row: any) => row._id as string));
    cursor = page.nextCursor;
    lastPage = page;
  } while (cursor !== null);
  return { seen, lastPage };
}

describe("products.listV2 token search (post-migration)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("migrates from the explicit pending state to cursor-paginated search via backfill", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertLegacyProducts(t, env, 5);

    // Pre-migration: explicit pending state, no match-set scan.
    const pending = await t.query(api.products.listV2, { search: "needle", limit: 2 });
    expect(pending.searchMigrationPending).toBe(true);
    expect(pending.data).toHaveLength(0);
    expect(pending.totalIsExact).toBe(false);

    await completeSearchMigration(t);

    // Post-migration: versioned semantics — non-exact totals, cursor pages.
    const page = await t.query(api.products.listV2, { search: "needle", limit: 2 });
    expect(page.totalIsExact).toBe(false);
    expect(page.total).toBe(SEARCH_TOTAL_UNKNOWN);
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const { seen } = await drainSearch(t, { search: "needle" }, 2);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("keeps match sets larger than 512 pageable instead of failing", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertLegacyProducts(t, env, 600);
    await completeSearchMigration(t);

    const { seen, lastPage } = await drainSearch(t, { search: "needle" }, 50);
    expect(seen).toHaveLength(600);
    expect(new Set(seen).size).toBe(600);
    expect(lastPage.totalIsExact).toBe(false);

    // deterministic newest-first order across the whole drain
    const ordered = await t.run(async (ctx) =>
      (await ctx.db.query("products").collect()).map((row) => ({
        id: row._id as string,
        updated_at: row.updated_at,
      })),
    );
    const byId = new Map(ordered.map((row) => [row.id, row.updated_at]));
    const timestamps = seen.map((id) => byId.get(id)!);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index]).toBeLessThanOrEqual(timestamps[index - 1]);
    }
  });

  it("paginates equal updated_at values without gaps or duplicates", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertLegacyProducts(t, env, 25, { updatedAt: () => 5_000 });
    await completeSearchMigration(t);

    const { seen } = await drainSearch(t, { search: "needle" }, 4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("applies status, category, and brand filters across multiple pages", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    const otherCategory = await t.run(async (ctx) =>
      ctx.db.insert("categories", {
        name: "Other",
        slug: "other",
        sort_order: 2,
        is_active: true,
      }),
    );
    await t.run(async (ctx) => {
      const statuses = ["active", "draft", "discontinued"] as const;
      for (let n = 0; n < 18; n += 1) {
        await ctx.db.insert("products", {
          ...legacyProductRow(env, n, {
            status: statuses[n % 3],
            updatedAt: 5_000,
          }),
          primary_category_id: n % 2 === 0 ? env.categoryId : otherCategory,
          ...(n % 4 === 0 ? {} : { brand_id: undefined }),
        });
      }
    });
    await completeSearchMigration(t);

    const all = await drainSearch(t, { search: "needle" }, 5);
    expect(all.seen).toHaveLength(18);

    const active = await drainSearch(t, { search: "needle", status: "active" }, 2);
    expect(active.seen).toHaveLength(6);

    const combo = await drainSearch(
      t,
      { search: "needle", status: "draft", category_id: otherCategory },
      2,
    );
    expect(combo.seen).toHaveLength(3);

    const branded = await drainSearch(t, { search: "needle", brand_id: env.brandId }, 3);
    expect(branded.seen).toHaveLength(5);
  });

  it("matches multi-token queries only when every token is present", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await t.run(async (ctx) => {
      for (const [index, name] of [
        "Fresh Milk 1L",
        "Fresh Bread",
        "Sour Milk 500ml",
      ].entries()) {
        await ctx.db.insert("products", legacyProductRow(env, index, { name }));
      }
    });
    await completeSearchMigration(t);

    const { seen } = await drainSearch(t, { search: "fresh milk" }, 10);
    expect(seen).toHaveLength(1);
    const names = await t.run(async (ctx) =>
      Promise.all(seen.map(async (id) => (await ctx.db.get(id as Id<"products">))?.name)),
    );
    expect(names).toEqual(["Fresh Milk 1L"]);
  });

  it("documents the versioned token-matching semantics", async () => {
    expect(searchTokensForName("Coca-Cola 1.5L")).toEqual(["coca", "cola", "1", "5l"]);
    expect(searchTokensForName("  Fresh   MILK ")).toEqual(["fresh", "milk"]);
    expect(searchTokensForName("7-Up")).toEqual(["7", "up"]);

    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await t.run(async (ctx) => {
      for (const [index, name] of [
        "Coca-Cola 1.5L",
        "Fresh Milk 1L",
        "Milo Drink",
      ].entries()) {
        await ctx.db.insert("products", legacyProductRow(env, index, { name }));
      }
    });
    await completeSearchMigration(t);

    // punctuation splits into tokens, matched case-insensitively
    expect((await drainSearch(t, { search: "COCA" }, 10)).seen).toHaveLength(1);
    expect((await drainSearch(t, { search: "cola" }, 10)).seen).toHaveLength(1);
    // token order does not matter; every token must match
    expect((await drainSearch(t, { search: "milk fresh" }, 10)).seen).toHaveLength(1);
    // single-character tokens are matched exactly ("1l" is not "1")
    expect((await drainSearch(t, { search: "1" }, 10)).seen).toHaveLength(1);
    // intentional change vs. substring behavior: no prefix matching
    expect((await drainSearch(t, { search: "mil" }, 10)).seen).toHaveLength(0);
    expect((await drainSearch(t, { search: "milo" }, 10)).seen).toHaveLength(1);
  });

  it("maintains token rows on create, update, and delete", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await completeSearchMigration(t);

    const id = await t.mutation(api.products.create, {
      primary_category_id: env.categoryId,
      brand_id: env.brandId,
      name: "Writertoken Alpha",
      status: "active",
    });
    let page = await t.query(api.products.listV2, { search: "writertoken", limit: 10 });
    expect(page.data.map((row: any) => row._id)).toEqual([id]);

    await t.mutation(api.products.update, { id, name: "Renamed Beta" });
    page = await t.query(api.products.listV2, { search: "writertoken", limit: 10 });
    expect(page.data).toHaveLength(0);
    page = await t.query(api.products.listV2, { search: "renamed", limit: 10 });
    expect(page.data.map((row: any) => row._id)).toEqual([id]);

    // status change is reflected in token-row filters
    await t.mutation(api.products.update, { id, status: "draft" });
    page = await t.query(api.products.listV2, { search: "renamed", status: "active", limit: 10 });
    expect(page.data).toHaveLength(0);
    page = await t.query(api.products.listV2, { search: "renamed", status: "draft", limit: 10 });
    expect(page.data).toHaveLength(1);

    await t.mutation(api.products.remove, { id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    page = await t.query(api.products.listV2, { search: "renamed", limit: 10 });
    expect(page.data).toHaveLength(0);
    const tokenRows = await t.run(async (ctx) =>
      ctx.db
        .query("productSearchTokens")
        .withIndex("by_product", (q) => q.eq("product_id", id))
        .collect(),
    );
    expect(tokenRows).toHaveLength(0);
  });
});

describe("products.listV2 token search read bounds", () => {
  function catalog(matchCount: number, unrelatedCount: number) {
    const matches = Array.from({ length: matchCount }, (_, index) =>
      doc("products", {
        _id: `match_${index}`,
        brand_id: "brand_a",
        primary_category_id: "cat_a",
        name: `Target ${index}`,
        slug: `target-${index}`,
        status: "active",
        rating_average: 0,
        rating_count: 0,
        sku_count: 1,
        total_stock: 2,
        productListSummaryVersion: 2,
        attributes: [],
        created_at: 1,
        updated_at: 10_000 + index,
      }),
    );
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) =>
      doc("products", {
        _id: `other_${index}`,
        brand_id: "brand_b",
        primary_category_id: "cat_b",
        name: `Other ${index}`,
        slug: `other-${index}`,
        status: "draft",
        rating_average: 0,
        rating_count: 0,
        sku_count: 1,
        total_stock: 2,
        productListSummaryVersion: 2,
        attributes: [],
        created_at: 1,
        updated_at: index,
      }),
    );
    return new FakeConvexDb({
      products: [...matches, ...unrelated],
      productSearchTokens: matches.flatMap((row) =>
        searchTokensForName(row.name as string).map((token) =>
          doc("productSearchTokens", {
            _id: `tok_${row._id}_${token}`,
            product_id: row._id,
            token,
            tokens: searchTokensForName(row.name as string),
            updated_at: row.updated_at,
            status: "active",
            primary_category_id: "cat_a",
            brand_id: "brand_a",
          }),
        ),
      ),
      transitionState: [
        doc("transitionState", {
          _id: "ts_search",
          key: "productSearchTokens",
          complete: true,
        }),
      ],
      brands: [
        doc("brands", { _id: "brand_a", name: "Brand A", is_active: true }),
      ],
      categories: [
        doc("categories", {
          _id: "cat_a",
          name: "Cat A",
          slug: "cat-a",
          sort_order: 1,
          is_active: true,
        }),
      ],
      listCounts: [],
    });
  }

  it("keeps search page reads constant while matching and unrelated products grow", async () => {
    const snapshots: Record<string, unknown>[] = [];
    for (const [matchCount, unrelatedCount] of [
      [300, 50],
      [2_000, 2_000],
    ]) {
      const db = catalog(matchCount, unrelatedCount);
      const result = await listHandler({ db }, { search: "target", limit: 10 });
      expect(result.data).toHaveLength(10);
      expect(result.totalIsExact).toBe(false);
      expect(result.total).toBe(SEARCH_TOTAL_UNKNOWN);
      expect(result.hasMore).toBe(true);
      snapshots.push({
        tokenDocs:
          db.stats.documentsReturned["productSearchTokens.by_token_updated"] ?? 0,
        productGets: db.stats.get.products ?? 0,
        searchIndexDocs:
          db.stats.documentsReturned["products.search:search_products"] ?? 0,
        productIndexDocs: db.stats.documentsReturned["products.by_updated"] ?? 0,
      });
    }
    // Work is one page-sized paginated token read plus page-sized gets —
    // identical for 300 and 2,000 matches, and the unpaginatable search
    // index is never touched post-migration.
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].tokenDocs).toBeLessThanOrEqual(10);
    expect(snapshots[0].productGets).toBeLessThanOrEqual(10);
    expect(snapshots[0].searchIndexDocs).toBe(0);
    expect(snapshots[0].productIndexDocs).toBe(0);
  });
});
