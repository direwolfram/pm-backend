import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import {
  compareProductsNewestFirst,
  listHandler,
  PRODUCT_LIST_SCAN_CAP,
} from "../convex/products";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

const CAP = PRODUCT_LIST_SCAN_CAP;

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

function productRow(
  env: { categoryId: Id<"categories">; brandId: Id<"brands"> },
  n: number,
  opts?: { updatedAt?: number; status?: string; name?: string; summarized?: boolean },
) {
  const summarized = opts?.summarized ?? true;
  return {
    primary_category_id: env.categoryId,
    brand_id: env.brandId,
    name: opts?.name ?? `Contract Product ${n}`,
    slug: `contract-${n}-${Math.random()}`,
    status: opts?.status ?? "active",
    rating_average: 0,
    rating_count: 0,
    ...(summarized
      ? {
          sku_count: 0,
          total_stock: 0,
          productListSummaryVersion: 2,
        }
      : {}),
    attributes: [],
    created_at: 1,
    updated_at: opts?.updatedAt ?? 10_000 + n,
  };
}

async function insertProducts(
  t: ReturnType<typeof convexTest>,
  env: Awaited<ReturnType<typeof seedBase>>,
  count: number,
  opts?: { updatedAt?: (n: number) => number; name?: (n: number) => string },
) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await t.run(async (ctx) => {
      for (let n = start; n < end; n += 1) {
        await ctx.db.insert(
          "products",
          productRow(env, n, {
            updatedAt: opts?.updatedAt?.(n),
            name: opts?.name?.(n),
          }),
        );
      }
    });
  }
}

describe("products.listV2 contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches products.list on first page, total, and response shape", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, 9);

    const legacy = await t.query(api.products.list, { limit: 4 });
    const v2 = await t.query(api.products.listV2, { limit: 4 });
    expect(v2.data.map((row) => row._id)).toEqual(
      legacy.data.map((row) => row._id),
    );
    expect(v2).toMatchObject({
      total: 9,
      totalIsExact: true,
      limit: 4,
      offset: 0,
      hasMore: true,
    });
    expect(v2.total).toBe(legacy.total);
    expect(typeof v2.nextCursor).toBe("string");

    const legacySearch = await t.query(api.products.list, {
      search: "contract",
      status: "active",
      category_id: env.categoryId,
      brand_id: env.brandId,
      limit: 3,
    });
    const v2Search = await t.query(api.products.listV2, {
      search: "contract",
      status: "active",
      category_id: env.categoryId,
      brand_id: env.brandId,
      limit: 3,
    });
    expect(v2Search.data.map((row) => row._id)).toEqual(
      legacySearch.data.map((row) => row._id),
    );
    expect(v2Search.total).toBe(legacySearch.total);
  });

  it("rejects legacy offset arguments", async () => {
    const t = convexTest({ schema, modules });
    await seedBase(t);
    await expect(
      t.query(api.products.listV2, { limit: 5, offset: 0 } as never),
    ).rejects.toThrow();
  });

  it("paginates tied updated_at values without gaps or duplicates", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, 13, { updatedAt: () => 5_000 });
    const expected = (
      await t.run(async (ctx) => await ctx.db.query("products").collect())
    )
      .sort(compareProductsNewestFirst)
      .map((row) => row._id as string);

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const page = await t.query(api.products.listV2, { limit: 4, cursor });
      expect(page.total).toBe(13);
      seen.push(...page.data.map((row) => row._id as string));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(13);
  });

  it("paginates search deterministically newest-first across pages", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, 12, {
      updatedAt: (n) => 9_000 - 1_000 * Math.floor(n / 3),
      name: (n) => `Needle Product ${n}`,
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let lastUpdated = Number.POSITIVE_INFINITY;
    let guard = 0;
    do {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const page = await t.query(api.products.listV2, {
        search: "needle",
        limit: 5,
        cursor,
      });
      expect(page.total).toBe(12);
      for (const row of page.data) {
        expect(row.updated_at).toBeLessThanOrEqual(lastUpdated);
        lastUpdated = row.updated_at;
        seen.push(row._id as string);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("rejects a cursor reused with changed filters", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, 6);
    const first = await t.query(api.products.listV2, {
      status: "active",
      limit: 2,
    });
    await expect(
      t.query(api.products.listV2, {
        status: "draft",
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects search domains above the scan cap explicitly", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, CAP + 1, {
      name: (n) => `Needle Product ${n}`,
    });
    await expect(
      t.query(api.products.listV2, { search: "needle", limit: 10 }),
    ).rejects.toThrow(/narrow the search term/);
  });

  it("never falls back to an unbounded count when counters are missing", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, CAP + 1);
    await expect(t.query(api.products.listV2, { limit: 10 })).rejects.toThrow(
      /reconcileListCounts/,
    );

    let done = false;
    let cursor: string | undefined;
    let guard = 0;
    while (!done) {
      guard += 1;
      expect(guard).toBeLessThan(10);
      const result = await t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "products",
        cursor,
      });
      done = result.done;
      cursor = done ? undefined : (result as { nextCursor?: string }).nextCursor;
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const page = await t.query(api.products.listV2, { limit: 10 });
    expect(page.total).toBe(CAP + 1);
    expect(page.totalIsExact).toBe(true);
  });

  it("returns an empty page for empty domains", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    await insertProducts(t, env, 3);
    const page = await t.query(api.products.listV2, {
      search: "absent",
      limit: 5,
    });
    expect(page).toMatchObject({ total: 0, hasMore: false, nextCursor: null });
    expect(page.data).toHaveLength(0);
  });
});

describe("products.list legacy rows and read-only enforcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves unsummarized legacy rows from stored fields, flags them pending, and never scans children", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedBase(t);
    const productId = await t.run(async (ctx) => {
      const pid = await ctx.db.insert(
        "products",
        productRow(env, 1, { summarized: false }),
      );
      const skuId = await ctx.db.insert("skus", {
        product_id: pid,
        sku_code: "LEG-1",
        variant_label: "V",
        sort_order: 0,
        is_default: true,
        is_active: true,
      });
      await ctx.db.insert("inventory", {
        sku_id: skuId,
        productId: pid,
        quantity_available: 7,
        status: "in_stock",
      });
      // Active price with NO pricesActive mirror (pre-migration state).
      await ctx.db.insert("prices", {
        sku_id: skuId,
        product_id: pid,
        currency: "PHP",
        sale_price: 19,
        starts_at: Date.now() - 1_000,
        priceSummaryVersion: 2,
      });
      return pid;
    });

    // Request-time summary scans are gone: the row is served from its stored
    // (absent) fields and explicitly flagged as pending migration.
    const page = await t.query(api.products.listV2, { limit: 5 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      sku_count: 0,
      total_stock: 0,
    });
    expect(page.data[0].default_price).toBeUndefined();
    expect(page.summariesPending).toBe(1);

    // The query must not repair/patch anything: the row stays unsummarized.
    const after = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(after?.productListSummaryVersion).toBeUndefined();
    expect(after?.sku_count).toBeUndefined();

    // The bounded backfill migration computes the summary instead.
    await t.mutation(internal.products.backfillProductListSummaries, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const migrated = await t.query(api.products.listV2, { limit: 5 });
    expect(migrated.summariesPending).toBe(0);
    expect(migrated.data[0]).toMatchObject({
      sku_count: 1,
      total_stock: 7,
      default_price: 19,
    });
  });

  it("performs no writes, patches, or scheduled work from the query path", async () => {
    const target = Array.from({ length: 8 }, (_, index) =>
      doc("products", {
        _id: `p_${index}`,
        brand_id: "brand_a",
        primary_category_id: "cat_a",
        name: `Product ${index}`,
        slug: `p-${index}`,
        status: "active",
        rating_average: 0,
        rating_count: 0,
        sku_count: 1,
        total_stock: 3,
        default_price: 9,
        productListSummaryVersion: 2,
        attributes: [],
        created_at: 1,
        updated_at: 1_000 - index,
      }),
    );
    const db = new FakeConvexDb({
      products: target,
      listCounts: [
        doc("listCounts", {
          _id: "lc_all",
          scope: "products",
          key: "all",
          count: 8,
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
    });
    const guarded = new Proxy(db, {
      get(targetObj, prop, receiver) {
        if (
          prop === "patch" ||
          prop === "insert" ||
          prop === "delete" ||
          prop === "replace"
        ) {
          throw new Error(`query attempted a write: ${String(prop)}`);
        }
        return Reflect.get(targetObj, prop, receiver);
      },
    });

    const result = await listHandler({ db: guarded }, { limit: 4 });
    expect(result.data).toHaveLength(4);
    expect(result.total).toBe(8);
  });
});

describe("products.listV2 read bounds as catalog grows", () => {
  function catalog(targetCount: number, unrelatedCount: number) {
    const target = Array.from({ length: targetCount }, (_, index) =>
      doc("products", {
        _id: `target_${index}`,
        brand_id: "brand_a",
        primary_category_id: "cat_a",
        name: `Target ${index}`,
        slug: `target-${index}`,
        status: "active",
        rating_average: 0,
        rating_count: 0,
        sku_count: 1,
        default_sku_id: `sku_target_${index}`,
        default_price: 5,
        total_stock: 2,
        productListSummaryVersion: 2,
        attributes: [],
        created_at: 1,
        updated_at: 10_000 - index,
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
        default_sku_id: `sku_other_${index}`,
        default_price: 5,
        total_stock: 2,
        productListSummaryVersion: 2,
        attributes: [],
        created_at: 1,
        updated_at: index,
      }),
    );
    return new FakeConvexDb({
      products: [...target, ...unrelated],
      listCounts: [
        doc("listCounts", {
          _id: "lc_status",
          scope: "products",
          key: "status:active",
          count: targetCount,
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
      skus: unrelated.map((row) =>
        doc("skus", {
          _id: `sku_${row._id}`,
          product_id: row._id,
          sku_code: `SKU-${row._id}`,
          variant_label: "V",
          sort_order: 0,
          is_default: true,
          is_active: true,
        }),
      ),
      prices: unrelated.map((row) =>
        doc("prices", {
          _id: `price_${row._id}`,
          sku_id: `sku_${row._id}`,
          product_id: row._id,
          currency: "PHP",
          sale_price: 1,
          starts_at: 1,
          priceSummaryVersion: 2,
        }),
      ),
      inventory: unrelated.map((row) =>
        doc("inventory", {
          _id: `inv_${row._id}`,
          sku_id: `sku_${row._id}`,
          productId: row._id,
          quantity_available: 1,
          status: "in_stock",
        }),
      ),
      pricesActive: target.map((row) =>
        doc("pricesActive", {
          _id: `pa_${row._id}`,
          sku_id: `sku_${row._id}`,
          price_id: `price_${row._id}`,
          product_id: row._id,
          sale_price: 5,
          starts_at: 1,
        }),
      ),
    });
  }

  it("keeps first-page reads constant while unrelated catalog data grows", async () => {
    const snapshots: Record<string, unknown>[] = [];
    for (const unrelatedCount of [50, 2_000]) {
      const db = catalog(20, unrelatedCount);
      const result = await listHandler(
        { db },
        { status: "active", limit: 5 },
      );
      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(20);
      // No full-table or child-table scans: only the products index page,
      // deduped brand/category gets, and one mirror read per page row.
      expect(db.stats.collect.products).toBeUndefined();
      expect(db.stats.collect.skus).toBeUndefined();
      expect(db.stats.collect.prices).toBeUndefined();
      expect(db.stats.collect.inventory).toBeUndefined();
      expect(db.stats.collect.brands).toBeUndefined();
      expect(db.stats.collect.categories).toBeUndefined();
      snapshots.push({
        productDocs:
          db.stats.documentsReturned["products.by_status_updated"] ?? 0,
        mirrorReads:
          db.stats.documentsReturned["pricesActive.by_sku"] ?? 0,
        brandGets: db.stats.get.brands ?? 0,
        categoryGets: db.stats.get.categories ?? 0,
        dataLength: result.data.length,
      });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].productDocs).toBeLessThanOrEqual(5);
    expect(snapshots[0].mirrorReads).toBeLessThanOrEqual(5);
    expect(snapshots[0].brandGets).toBe(1);
    expect(snapshots[0].categoryGets).toBe(1);
  });

  it("keeps search page reads proportional to the match set, not the catalog", async () => {
    const reads: number[] = [];
    for (const unrelatedCount of [50, 2_000]) {
      const db = catalog(20, unrelatedCount);
      const result = await listHandler(
        { db },
        { search: "target", limit: 5 },
      );
      expect(result.total).toBe(20);
      expect(result.data).toHaveLength(5);
      reads.push(
        db.stats.documentsReturned["products.search:search_products"] ?? 0,
      );
    }
    expect(reads[0]).toBe(20);
    expect(reads[1]).toBe(20);
  });
});
