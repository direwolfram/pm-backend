import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { boundedPageArgs, now, pageResponse, slugify, unwrapCursor, wrapCursor } from "./helpers";
import {
  deletePricesActiveForSku,
  PRODUCT_LIST_SUMMARY_VERSION,
  recomputeProductListSummary,
} from "./lib/productListSummaries";
import {
  deleteProductSearchTokens,
  markProductSearchMigrationComplete,
  PRODUCT_SEARCH_TOKENS_VERSION,
  productSearchMigrationComplete,
  SEARCH_TOTAL_UNKNOWN,
  searchProductsPage,
  searchTokensForQuery,
  syncProductSearchTokens,
} from "./lib/productSearchTokens";
import { deletePriceCascade } from "./prices";
import {
  applyListCountChange,
  exactListTotal,
  productCountKeys,
  productTotalKey,
} from "./listCounts";
import type { Id } from "./_generated/dataModel";
import type {
  ProductDoc,
  ProductListRow,
  ProductMediaDoc,
  SkuDoc,
} from "./model";

const productStatus = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("hidden"),
  v.literal("discontinued"),
);

/**
 * Hard cap on documents a single list request may scan outside its returned
 * page (counter-missing totals). Index ranges cannot be counted without
 * reading them, so these domains are read with take(CAP + 1) and rejected
 * explicitly when larger — never silently truncated and never an unbounded
 * collect.
 */
export const PRODUCT_LIST_SCAN_CAP = 512;

/** Deterministic newest-first total order with a unique tie-breaker. */
export function compareProductsNewestFirst(a: ProductDoc, b: ProductDoc) {
  if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

/**
 * Bounded exact count of a query domain; throws when the domain exceeds the
 * cap so callers never see a silently truncated total.
 */
async function boundedDomainCount(
  buildQuery: () => { take: (n: number) => Promise<unknown[]> },
  cap: number,
  tooLargeMessage: string,
) {
  const rows = await buildQuery().take(cap + 1);
  if (rows.length > cap) throw new Error(tooLargeMessage);
  return rows.length;
}

const dummyProductImageColors = ["F7C948", "90CDF4", "C6F6D5", "FBB6CE"];
const SIMILAR_PRODUCT_LIMIT = 24;
const CASCADE_BATCH_LIMIT = 100;

function dummyImagesForProduct(name: string) {
  return dummyProductImageColors.map((color, index) => {
    const label = index === 0 ? `${name} Showcase` : `${name} Slide ${index + 1}`;
    return `https://placehold.co/800x800/${color}/111827?text=${encodeURIComponent(label)}`;
  });
}

function productListIndex(args: {
  status?: ProductDoc["status"];
  category_id?: string;
  brand_id?: string;
}) {
  if (args.category_id && args.brand_id && args.status) {
    return "by_category_brand_status_updated";
  }
  if (args.category_id && args.brand_id) return "by_category_brand_updated";
  if (args.category_id && args.status) return "by_category_status_updated";
  if (args.brand_id && args.status) return "by_brand_status_updated";
  if (args.category_id) return "by_category_updated";
  if (args.brand_id) return "by_brand_updated";
  if (args.status) return "by_status_updated";
  return "by_updated";
}

function productListScope(args: {
  search?: string;
  status?: ProductDoc["status"];
  category_id?: string;
  brand_id?: string;
}) {
  return {
    q: "products.list",
    search: args.search?.trim().toLowerCase() ?? "",
    status: args.status ?? "",
    category_id: args.category_id ?? "",
    brand_id: args.brand_id ?? "",
  };
}

async function pageProducts(
  ctx: { db: any },
  args: {
    search?: string;
    status?: ProductDoc["status"];
    category_id?: string;
    brand_id?: string;
    limit?: number;
    offset?: number;
    cursor?: string | null;
  },
): Promise<{
  rows: ProductDoc[];
  pagination: {
    isDone: boolean;
    nextCursor: string | null;
    total: number;
    totalIsExact?: boolean;
  };
  searchMigrationPending?: boolean;
}> {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const useOffset = args.offset !== undefined && args.cursor === undefined;
  const scope = productListScope(args);
  const cursor = unwrapCursor(scope, args.cursor);
  const isSearch = !!args.search?.trim();
  if (isSearch) {
    const tokens = searchTokensForQuery(args.search!.trim());
    if (tokens.length === 0) {
      return {
        rows: [],
        pagination: {
          isDone: true,
          nextCursor: null,
          total: SEARCH_TOTAL_UNKNOWN,
          totalIsExact: false,
        },
      };
    }
    if (!(await productSearchMigrationComplete(ctx))) {
      // Explicit migration state: the productSearchTokens backfill has not
      // completed, so search reports itself unavailable rather than falling
      // back to a full-match scan. Run products.backfillProductSearchTokens.
      return {
        rows: [],
        pagination: {
          isDone: true,
          nextCursor: null,
          total: SEARCH_TOTAL_UNKNOWN,
          totalIsExact: false,
        },
        searchMigrationPending: true,
      };
    }
    // Versioned search semantics: genuine cursor pagination over the
    // productSearchTokens stream. Per-request work is one page-sized
    // paginated token-index read plus at most `limit` product gets —
    // independent of the match count. Totals for arbitrary search are
    // explicitly non-exact (counting matches requires reading them): total
    // is the SEARCH_TOTAL_UNKNOWN sentinel with totalIsExact false.
    const page = await searchProductsPage(ctx, {
      tokens,
      status: args.status,
      category_id: args.category_id,
      brand_id: args.brand_id,
      limit,
      cursor,
    });
    return {
      rows: page.rows,
      pagination: {
        isDone: page.isDone,
        nextCursor:
          page.isDone || !page.continueCursor
            ? null
            : wrapCursor(scope, page.continueCursor),
        total: SEARCH_TOTAL_UNKNOWN,
        totalIsExact: false,
      },
    };
  }
  const makeBuilder = () =>
    ctx.db
      .query("products")
      .withIndex(productListIndex(args), (q: any) => {
        if (args.category_id && args.brand_id && args.status) {
          return q
            .eq("primary_category_id", args.category_id)
            .eq("brand_id", args.brand_id)
            .eq("status", args.status);
        }
        if (args.category_id && args.brand_id) {
          return q
            .eq("primary_category_id", args.category_id)
            .eq("brand_id", args.brand_id);
        }
        if (args.category_id && args.status) {
          return q.eq("primary_category_id", args.category_id).eq("status", args.status);
        }
        if (args.brand_id && args.status) {
          return q.eq("brand_id", args.brand_id).eq("status", args.status);
        }
        if (args.category_id) return q.eq("primary_category_id", args.category_id);
        if (args.brand_id) return q.eq("brand_id", args.brand_id);
        if (args.status) return q.eq("status", args.status);
        return q;
      });
  // Exact total: maintained counters (O(1)). Missing counter rows use a
  // bounded scan that rejects over-cap domains explicitly — never a
  // request-time full-range collect.
  const maintained = await exactListTotal(ctx, "products", productTotalKey(args));
  const total =
    maintained ??
    (await boundedDomainCount(
      makeBuilder,
      PRODUCT_LIST_SCAN_CAP,
      `Product list counters are missing for this filter and more than ${PRODUCT_LIST_SCAN_CAP} products match; run listCounts.reconcileListCounts for scope "products" before querying`,
    ));
  const ordered = makeBuilder().order("desc");
  if (!useOffset) {
    const result = await ordered.paginate({
      numItems: limit,
      cursor,
    });
    return {
      rows: result.page as ProductDoc[],
      pagination: {
        isDone: result.isDone,
        nextCursor:
          result.isDone || !result.continueCursor
            ? null
            : wrapCursor(scope, result.continueCursor),
        total,
      },
    };
  }
  const rows = (await ordered.take(limit + pageArgs.offset + 1)) as ProductDoc[];
  return {
    rows: rows.slice(pageArgs.offset, pageArgs.offset + limit),
    pagination: {
      isDone: rows.length <= pageArgs.offset + limit,
      nextCursor: null,
      total,
    },
  };
}

/**
 * Page-bounded enrichment: resolves brand/category display names (one get per
 * distinct id referenced by the page) and serves the stored list-summary
 * fields maintained by writers and products.backfillProductListSummaries.
 *
 * Request-time legacy summary scans were removed deliberately: a list query
 * must never inspect thousands of SKUs, prices, or inventory rows for an
 * unsummarized product. Rows whose productListSummaryVersion is stale are
 * served from their stored fields (zeros when absent) and counted in
 * `summariesPending` — the explicit migration-state signal telling callers a
 * backfill is still required. The query path performs no writes.
 */
async function enrichProductPage(ctx: { db: any }, rows: ProductDoc[]) {
  const [brands, categories] = await Promise.all([
    Promise.all(
      Array.from(
        new Set(rows.map((product) => product.brand_id).filter(Boolean)),
      ).map(
        async (id) =>
          [id, (await ctx.db.get(id as any)) as { name?: string } | null] as const,
      ),
    ),
    Promise.all(
      Array.from(new Set(rows.map((product) => product.primary_category_id))).map(
        async (id) =>
          [id, (await ctx.db.get(id as any)) as { name?: string } | null] as const,
      ),
    ),
  ]);
  const brandName = new Map(brands);
  const catName = new Map(categories);
  let summariesPending = 0;
  const data = rows.map((p): ProductListRow => {
    if (p.productListSummaryVersion !== PRODUCT_LIST_SUMMARY_VERSION) {
      summariesPending += 1;
    }
    return {
      ...p,
      brand_name: p.brand_id ? brandName.get(p.brand_id)?.name : undefined,
      brand: p.brand,
      category_name: catName.get(p.primary_category_id)?.name,
      sku_count: p.sku_count ?? 0,
      default_sku_id: p.default_sku_id,
      default_price: p.default_price,
      total_stock: p.total_stock ?? 0,
    };
  });
  return { data, summariesPending };
}

export async function listHandler(
  ctx: { db: any },
  args: {
    search?: string;
    status?: ProductDoc["status"];
    category_id?: string;
    brand_id?: string;
    limit?: number;
    offset?: number;
    cursor?: string | null;
  },
) {
  const { rows, pagination, searchMigrationPending } = await pageProducts(ctx, args);
  const { data, summariesPending } = await enrichProductPage(ctx, rows);
  return {
    ...pageResponse(data, args, pagination),
    summariesPending,
    searchMigrationPending: searchMigrationPending ?? false,
  };
}

/**
 * products.list — legacy-compatible endpoint.
 *
 * Preserved for legacy callers during the migration to products.listV2.
 * Semantics shared with listV2 (see pageProducts): deterministic newest-first
 * ordering (updated_at desc, _id desc), exact numeric totals for non-search
 * filters (maintained counters; bounded scans elsewhere), versioned
 * non-exact search totals over the cursor-paginated token stream, and legacy
 * offsets honored up to MAX_COMPAT_OFFSET (200) with a documented error
 * beyond. New callers must use products.listV2.
 */
export const list = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(productStatus),
    category_id: v.optional(v.id("categories")),
    brand_id: v.optional(v.id("brands")),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await listHandler(ctx, args);
  },
});

/**
 * products.listV2 — explicitly versioned, cursor-first endpoint.
 *
 * - Pagination: opaque cursors fingerprinted to search/status/category/brand
 *   filters; no `offset` argument — deep paging is cursor-only.
 * - Ordering: newest-first (updated_at desc, _id desc) on every path, so
 *   identical timestamps can never skip or duplicate rows across pages.
 * - Totals: exact numeric totals for non-search filter combinations via the
 *   maintained listCounts counters. Search totals are explicitly versioned:
 *   total is the SEARCH_TOTAL_UNKNOWN sentinel (-1) with totalIsExact false,
 *   because counting an arbitrary match set requires reading it.
 * - Search: cursor-paginated over the productSearchTokens stream once
 *   products.backfillProductSearchTokens has completed (migration state in
 *   transitionState); per-request work is one page-sized paginated token
 *   read plus page-sized product gets, independent of the match count.
 *   Until the backfill completes, search returns an explicit
 *   searchMigrationPending state instead of scanning match sets.
 * - Reads: one bounded page plus fixed metadata; enrichment fetches only the
 *   brands/categories referenced by the returned page, deduplicated, serves
 *   stored summary fields, reports stale summaries via summariesPending, and
 *   never writes from the query.
 */
export const listV2 = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(productStatus),
    category_id: v.optional(v.id("categories")),
    brand_id: v.optional(v.id("brands")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await listHandler(ctx, args);
  },
});

export async function getHandler(
  ctx: { db: any; storage: { getUrl(id: Id<"_storage">): Promise<string | null> } },
  args: { id: Id<"products"> },
) {
    const product = (await ctx.db.get(args.id)) as ProductDoc | null;
    if (!product) throw new Error("Product not found");
    const media = (await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect()) as ProductMediaDoc[];
    media.sort((a, b) => a.sort_order - b.sort_order);
    const resolvedMedia = await Promise.all(
      media.map(async (item) => {
        if (!item.storage_id) return item;
        const url = await ctx.storage.getUrl(item.storage_id as Id<"_storage">);
        return { ...item, url: url ?? item.url };
      }),
    );
    const similarPairs = await ctx.db
      .query("product_similar_products")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect();
    const similarIds = Array.from(
      new Set(similarPairs.map((p) => p.similar_product_id as string)),
    ).slice(0, SIMILAR_PRODUCT_LIMIT);
    const similar = (
      await Promise.all(
        similarIds.map(
          async (sid) =>
            (await ctx.db.get(sid as Id<"products">)) as ProductDoc | null,
        ),
      )
    ).filter((sp): sp is ProductDoc => !!sp);
    const skus = (await ctx.db
      .query("skus")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect()) as SkuDoc[];
    skus.sort((a, b) => a.sort_order - b.sort_order);
    const brand = product.brand_id ? await ctx.db.get(product.brand_id as Id<"brands">) : null;
    const category = await ctx.db.get(product.primary_category_id as Id<"categories">);
    return {
      ...product,
      media: resolvedMedia,
      similar,
      skus,
      brand_name: (brand as { name?: string } | null)?.name,
      category_name: (category as { name?: string } | null)?.name,
    };
}

export const get = query({
  args: { id: v.id("products") },
  handler: async (ctx, args) => {
    return await getHandler(ctx, args);
  },
});

const productFields = {
  sku: v.optional(v.string()),
  brand_id: v.optional(v.id("brands")),
  categoryId: v.optional(v.id("categories")),
  primary_category_id: v.id("categories"),
  name: v.string(),
  slug: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(productStatus),
  tag: v.optional(v.string()),
  pack_type: v.optional(v.string()),
  brand: v.optional(v.string()),
  basePrice: v.optional(v.number()),
  weightKg: v.optional(v.number()),
  volumeL: v.optional(v.number()),
  isFragile: v.optional(v.boolean()),
  isFlammable: v.optional(v.boolean()),
  temperatureZone: v.optional(
    v.union(v.literal("ambient"), v.literal("chilled"), v.literal("frozen")),
  ),
  packagingType: v.optional(v.string()),
  isFreshProduce: v.optional(v.boolean()),
  isReturnable: v.optional(v.boolean()),
  searchKeywords: v.optional(v.array(v.string())),
  images: v.optional(v.array(v.string())),
  substituteSkuIds: v.optional(v.array(v.string())),
  substitutePriority: v.optional(v.number()),
  allowSubstitution: v.optional(v.boolean()),
  isExpressAvailable: v.optional(v.boolean()),
  isFrequentlyBought: v.optional(v.boolean()),
  shelf_life: v.optional(v.string()),
  flavour: v.optional(v.string()),
  finish: v.optional(v.string()),
  paraben_free: v.optional(v.boolean()),
  colour_family: v.optional(v.string()),
  badge_text: v.optional(v.string()),
  icon_emoji: v.optional(v.string()),
  image_color: v.optional(v.string()),
  attributes: v.optional(
    v.array(v.object({ key: v.string(), label: v.string(), value: v.string() })),
  ),
};

export const create = mutation({
  args: productFields,
  handler: async (ctx, args) => {
    const slug = args.slug?.trim() || slugify(args.name);
    if (!slug) throw new Error("Product needs a name or slug");
    const dup = await ctx.db
      .query("products")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (dup) throw new Error(`Slug "${slug}" is already used`);
    const category = await ctx.db.get(args.primary_category_id);
    if (!category) throw new Error("Category not found");
    if ((category as { deleting_at?: number }).deleting_at) {
      throw new Error("Category is being deleted");
    }
    if (args.brand_id) {
      const brand = await ctx.db.get(args.brand_id);
      if (!brand) throw new Error("Brand not found");
      if ((brand as { deleting_at?: number }).deleting_at) {
        throw new Error("Brand is being deleted");
      }
    }
    const doc = {
      sku: args.sku,
      brand_id: args.brand_id,
      categoryId: args.categoryId ?? args.primary_category_id,
      primary_category_id: args.primary_category_id,
      name: args.name,
      slug,
      description: args.description,
      status: args.status ?? ("draft" as const),
      tag: args.tag,
      pack_type: args.pack_type,
      brand: args.brand,
      basePrice: args.basePrice,
      weightKg: args.weightKg,
      volumeL: args.volumeL,
      isFragile: args.isFragile,
      isFlammable: args.isFlammable,
      temperatureZone: args.temperatureZone,
      packagingType: args.packagingType,
      isFreshProduce: args.isFreshProduce,
      isReturnable: args.isReturnable,
      searchKeywords: args.searchKeywords,
      images: args.images,
      substituteSkuIds: args.substituteSkuIds,
      substitutePriority: args.substitutePriority,
      allowSubstitution: args.allowSubstitution,
      isExpressAvailable: args.isExpressAvailable,
      isFrequentlyBought: args.isFrequentlyBought,
      shelf_life: args.shelf_life,
      flavour: args.flavour,
      finish: args.finish,
      paraben_free: args.paraben_free,
      colour_family: args.colour_family,
      badge_text: args.badge_text,
      icon_emoji: args.icon_emoji,
      image_color: args.image_color,
      rating_average: 0,
      rating_count: 0,
      sku_count: 0,
      total_stock: 0,
      productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
      productSearchTokensVersion: PRODUCT_SEARCH_TOKENS_VERSION,
      attributes: args.attributes ?? [],
      created_at: now(),
      updated_at: now(),
    };
    const id = await ctx.db.insert("products", doc);
    await syncProductSearchTokens(ctx, { ...doc, _id: id } as ProductDoc);
    await applyListCountChange(ctx, "products", productCountKeys, null, doc);
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("products"),
    ...productFields,
    name: v.optional(v.string()),
    primary_category_id: v.optional(v.id("categories")),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const product = await ctx.db.get(id);
    if (!product) throw new Error("Product not found");
    if (patch.slug && patch.slug !== product.slug) {
      const dup = await ctx.db
        .query("products")
        .withIndex("by_slug", (q) => q.eq("slug", patch.slug!))
        .first();
      if (dup) throw new Error(`Slug "${patch.slug}" is already used`);
    }
    const categoryId = patch.categoryId ?? patch.primary_category_id;
    if (categoryId) {
      const category = await ctx.db.get(categoryId);
      if (!category) throw new Error("Category not found");
      if ((category as { deleting_at?: number }).deleting_at) {
        throw new Error("Category is being deleted");
      }
    }
    if (patch.brand_id) {
      const brand = await ctx.db.get(patch.brand_id);
      if (!brand) throw new Error("Brand not found");
      if ((brand as { deleting_at?: number }).deleting_at) {
        throw new Error("Brand is being deleted");
      }
    }
    await ctx.db.patch(id, {
      ...patch,
      ...(categoryId ? { categoryId } : {}),
      updated_at: now(),
    });
    const after = (await ctx.db.get(id)) as ProductDoc | null;
    if (after) {
      await syncProductSearchTokens(ctx, after);
      await applyListCountChange(
        ctx,
        "products",
        productCountKeys,
        product as ProductDoc,
        after,
      );
    }
    if (patch.name) {
      const inventory = await ctx.db
        .query("inventory")
        .withIndex("by_product_id", (q) => q.eq("productId", id))
        .collect();
      for (const row of inventory) {
        await ctx.db.patch(row._id, {
          productName: patch.name,
          storeInventorySummaryVersion: 1,
        });
      }
    }
    return id;
  },
});

export const backfillProductListSummaries = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const result = await ctx.db
      .query("products")
      .withIndex("by_product_list_summary_version", (q) =>
        // Stale means missing (undefined) OR any version older than current.
        q.lt("productListSummaryVersion", PRODUCT_LIST_SUMMARY_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let patched = 0;
    for (const product of result.page as ProductDoc[]) {
      if (await recomputeProductListSummary(ctx, product._id)) patched += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        anyApi.products.backfillProductListSummaries,
        { limit, cursor: result.continueCursor },
      );
    }
    return {
      processed: result.page.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});

/**
 * Backfills productSearchTokens rows for products written before the token
 * stream existed. Drains in bounded batches via the
 * by_product_search_tokens_version index and records completion in
 * transitionState ("productSearchTokens"), which flips list queries from the
 * legacy capped search-index fallback to cursor-paginated token search.
 */
export const backfillProductSearchTokens = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const result = await ctx.db
      .query("products")
      .withIndex("by_product_search_tokens_version", (q) =>
        q.lt("productSearchTokensVersion", PRODUCT_SEARCH_TOKENS_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let synced = 0;
    for (const product of result.page as ProductDoc[]) {
      await syncProductSearchTokens(ctx, product);
      synced += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        anyApi.products.backfillProductSearchTokens,
        { limit, cursor: result.continueCursor },
      );
    } else {
      await markProductSearchMigrationComplete(ctx);
    }
    return {
      processed: result.page.length,
      synced,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
      complete: result.isDone,
    };
  },
});

/** SQL cascade: media, similar pairs, SKUs (+ their prices/inventory). */
export const remove = mutation({
  args: { id: v.id("products") },
  handler: async (ctx, args) => {
    const product = (await ctx.db.get(args.id)) as ProductDoc | null;
    if (!product) return { id: args.id, deleting: true };
    const orderItem = await ctx.db
      .query("order_items")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .first();
    if (orderItem) {
      throw new Error(
        "Cannot delete: this product appears in orders. Set status to discontinued instead.",
      );
    }
    if (!product.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continueProductDelete = internalMutation({
  args: { id: v.id("products") },
  handler: async (ctx, args) => {
    const product = (await ctx.db.get(args.id)) as ProductDoc | null;
    if (!product) return { done: true, deleted: true };
    const orderItem = await ctx.db
      .query("order_items")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .first();
    if (orderItem) throw new Error("Cannot delete: this product appears in orders");
    let operations = 0;
    const media = await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const m of media) {
      await ctx.db.delete(m._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }

    const [outgoingPairs, incomingPairs] = await Promise.all([
      ctx.db
        .query("product_similar_products")
        .withIndex("by_product", (q) => q.eq("product_id", args.id))
        .take(CASCADE_BATCH_LIMIT),
      ctx.db
        .query("product_similar_products")
        .withIndex("by_similar_product", (q) =>
          q.eq("similar_product_id", args.id),
        )
        .take(CASCADE_BATCH_LIMIT),
    ]);
    const pairIds = new Set(
      [...outgoingPairs, ...incomingPairs].map((pair) => pair._id),
    );
    for (const id of pairIds) {
      if (operations >= CASCADE_BATCH_LIMIT) break;
      await ctx.db.delete(id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const prices = await ctx.db
      .query("prices")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const pr of prices) {
      await deletePriceCascade(ctx, pr);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const inv = await ctx.db
      .query("inventory")
      .withIndex("by_product_id", (q) => q.eq("productId", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const i of inv) {
      await ctx.db.delete(i._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const skus = await ctx.db
      .query("skus")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const s of skus) {
      // Keep pricesActive consistent: mirrors of this SKU's prices go with it.
      await deletePricesActiveForSku(ctx, s._id);
      await ctx.db.delete(s._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const items = await ctx.db
      .query("home_section_items")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const item of items) {
      await ctx.db.delete(item._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const targets = await ctx.db
      .query("promotion_targets")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const t of targets) {
      await ctx.db.delete(t._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.products.continueProductDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await deleteProductSearchTokens(ctx, args.id);
    await applyListCountChange(
      ctx,
      "products",
      productCountKeys,
      product,
      null,
    );
    await ctx.db.delete(args.id);
    return { done: true, operations };
  },
});

// ---- Media ----

export const addMedia = mutation({
  args: {
    product_id: v.id("products"),
    url: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")),
    alt_text: v.optional(v.string()),
    dominant_color: v.optional(v.string()),
    is_showcase: v.optional(v.boolean()),
    sort_order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.url && !args.storage_id) throw new Error("Media needs a URL or uploaded file");
    const product = (await ctx.db.get(args.product_id)) as ProductDoc | null;
    if (!product) throw new Error("Product not found");
    if (product.deleting_at) throw new Error("Product is being deleted");
    const existing = await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.product_id))
      .collect();
    const shouldShowcase = args.is_showcase ?? existing.length === 0;
    if (shouldShowcase) {
      for (const media of existing) {
        await ctx.db.patch(media._id, { is_showcase: false });
      }
    }
    const url = args.url ?? "";
    return await ctx.db.insert("product_media", {
      product_id: args.product_id,
      url,
      storage_id: args.storage_id,
      alt_text: args.alt_text,
      dominant_color: args.dominant_color,
      is_showcase: shouldShowcase,
      sort_order: args.sort_order ?? existing.length,
    });
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const setShowcaseMedia = mutation({
  args: { product_id: v.id("products"), media_id: v.id("product_media") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.product_id))
      .collect();
    if (!rows.some((row) => row._id === args.media_id)) {
      throw new Error("Media does not belong to this product");
    }
    for (const row of rows) {
      await ctx.db.patch(row._id, { is_showcase: row._id === args.media_id });
    }
    return args.media_id;
  },
});

export const upsertDummyImages = mutation({
  args: {},
  handler: async (ctx) => {
    const timestamp = now();
    const products = ((await ctx.db.query("products").collect()) as ProductDoc[])
      .sort((a, b) => a.name.localeCompare(b.name));
    const media = (await ctx.db.query("product_media").collect()) as ProductMediaDoc[];
    const mediaByProduct = new Map<string, ProductMediaDoc[]>();
    for (const item of media) {
      const items = mediaByProduct.get(item.product_id) ?? [];
      items.push(item);
      mediaByProduct.set(item.product_id, items);
    }

    let productsUpdated = 0;
    let mediaInserted = 0;
    let mediaUpdated = 0;
    for (const product of products) {
      const images = dummyImagesForProduct(product.name);
      await ctx.db.patch(product._id as Id<"products">, {
        images,
        updated_at: timestamp,
      });
      await syncProductSearchTokens(ctx, {
        ...product,
        images,
        updated_at: timestamp,
      });
      productsUpdated += 1;

      const existing = mediaByProduct.get(product._id) ?? [];
      for (const item of existing) {
        if (item.is_showcase) {
          await ctx.db.patch(item._id as Id<"product_media">, { is_showcase: false });
          mediaUpdated += 1;
        }
      }
      for (const [index, url] of images.entries()) {
        const match = existing.find((item) => item.url === url);
        const patch = {
          alt_text: `${product.name} image ${index + 1}`,
          is_showcase: index === 0,
          sort_order: index,
        };
        if (match) {
          await ctx.db.patch(match._id as Id<"product_media">, patch);
          mediaUpdated += 1;
        } else {
          await ctx.db.insert("product_media", {
            product_id: product._id as Id<"products">,
            url,
            ...patch,
          });
          mediaInserted += 1;
        }
      }
    }

    return { productsUpdated, mediaInserted, mediaUpdated };
  },
});

export const removeMedia = mutation({
  args: { id: v.id("product_media") },
  handler: async (ctx, args) => {
    const media = (await ctx.db.get(args.id)) as ProductMediaDoc | null;
    if (!media) return;
    await ctx.db.delete(args.id);
    if (!media.is_showcase) return;
    const next = await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", media.product_id as Id<"products">))
      .collect();
    next.sort((a, b) => a.sort_order - b.sort_order);
    if (next[0]) await ctx.db.patch(next[0]._id, { is_showcase: true });
  },
});

// ---- Similar products ----

export const setSimilar = mutation({
  args: {
    product_id: v.id("products"),
    similar_product_ids: v.array(v.id("products")),
  },
  handler: async (ctx, args) => {
    const product = (await ctx.db.get(args.product_id)) as ProductDoc | null;
    if (!product) throw new Error("Product not found");
    if (product.deleting_at) throw new Error("Product is being deleted");
    // Hard cardinality cap keeps replacement a single bounded transaction
    // (reads + writes stay <= 2 * SIMILAR_PRODUCT_LIMIT + a constant).
    if (args.similar_product_ids.length > SIMILAR_PRODUCT_LIMIT) {
      throw new Error(
        `A product can have at most ${SIMILAR_PRODUCT_LIMIT} similar products`,
      );
    }
    const targets = new Set(
      args.similar_product_ids.filter((sid) => sid !== args.product_id),
    );
    const existing = (await ctx.db
      .query("product_similar_products")
      .withIndex("by_product", (q) => q.eq("product_id", args.product_id))
      .take(SIMILAR_PRODUCT_LIMIT + 1)) as {
      _id: string;
      similar_product_id: string;
    }[];
    const existingTargets = new Set(existing.map((p) => p.similar_product_id));
    for (const pair of existing) {
      if (!targets.has(pair.similar_product_id as (typeof args.product_id))) {
        await ctx.db.delete(pair._id as any);
      }
    }
    for (const sid of targets) {
      if (existingTargets.has(sid)) continue;
      const similar = (await ctx.db.get(sid)) as ProductDoc | null;
      if (!similar) throw new Error("Similar product not found");
      if (similar.deleting_at) {
        throw new Error("Similar product is being deleted");
      }
      await ctx.db.insert("product_similar_products", {
        product_id: args.product_id,
        similar_product_id: sid,
      });
    }
  },
});
