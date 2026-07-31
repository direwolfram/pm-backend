import { v } from "convex/values";
import { mutation, query } from "./functions";
import { deriveInventoryStatus, now, slugify } from "./helpers";
import {
  CATALOG_CATEGORIES,
  TARGET_SKU_COUNT,
  expandCatalog,
  type CatalogProduct,
} from "./catalogData";
import {
  PRODUCT_SEARCH_TOKENS_VERSION,
  searchTokensForName,
} from "./lib/productSearchTokens";
import { PRODUCT_LIST_SUMMARY_VERSION } from "./lib/productListSummaries";
import {
  bumpListCount,
  bumpListCountMutationGeneration,
  inventoryCountKeys,
  productCountKeys,
  skuCountKeys,
} from "./listCounts";
import type { Id as ConvexId } from "./_generated/dataModel";

const STORE_DEFS = [
  {
    name: "PocketMart Makati Central",
    status: "active" as const,
    address: "123 Kalayaan Ave, Poblacion, Makati, Metro Manila",
    latitude: 14.5653,
    longitude: 121.0306,
    timezone: "Asia/Manila",
  },
  {
    name: "PocketMart Quezon City",
    status: "active" as const,
    address: "45 Commonwealth Ave, Batasan Hills, Quezon City",
    latitude: 14.676,
    longitude: 121.0437,
    timezone: "Asia/Manila",
  },
];

function placeholderImages(name: string, color: string) {
  const hex = color.replace("#", "");
  return [0, 1, 2, 3].map((i) => {
    const label = i === 0 ? `${name} Showcase` : `${name} Slide ${i + 1}`;
    return `https://placehold.co/800x800/${hex}/111827?text=${encodeURIComponent(label)}`;
  });
}

async function ensureStores(ctx: any, t: number) {
  const existing = await ctx.db.query("stores").take(2);
  const stores: { id: ConvexId<"stores">; name: string }[] = existing.map(
    (s: any) => ({ id: s._id, name: s.name }),
  );
  for (const def of STORE_DEFS) {
    if (stores.length >= 2) break;
    const id = await ctx.db.insert("stores", {
      ...def,
      created_at: t,
      updated_at: t,
    });
    stores.push({ id, name: def.name });
  }
  return stores;
}

async function ensureCategories(ctx: any) {
  const ids = new Map<string, ConvexId<"categories">>();
  for (const cat of CATALOG_CATEGORIES) {
    const found = await ctx.db
      .query("categories")
      .withIndex("by_slug", (q: any) => q.eq("slug", cat.slug))
      .first();
    if (found) {
      ids.set(cat.slug, found._id);
      continue;
    }
    const id = await ctx.db.insert("categories", {
      parent_id: cat.parent ? ids.get(cat.parent) : undefined,
      name: cat.name,
      slug: cat.slug,
      section_name: cat.section,
      icon_emoji: cat.emoji,
      background_color: cat.color,
      image_color: cat.color,
      sort_order: cat.sort,
      is_active: true,
    });
    ids.set(cat.slug, id);
  }
  return ids;
}

async function ensureBrand(
  ctx: any,
  cache: Map<string, ConvexId<"brands">>,
  name: string,
  color: string,
) {
  const cached = cache.get(name);
  if (cached) return cached;
  const found = await ctx.db
    .query("brands")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .first();
  if (found) {
    cache.set(name, found._id);
    return found._id as ConvexId<"brands">;
  }
  const id = await ctx.db.insert("brands", {
    name,
    logo_color: color,
    is_active: true,
  });
  cache.set(name, id);
  return id as ConvexId<"brands">;
}

/**
 * Imports the Philippine quick-commerce catalog (see catalogData.ts): 53
 * categories, ~350 brands, 1,054 products and exactly 1,500 SKUs with
 * prices, active-price mirrors, per-store inventory, product search tokens
 * and media. Batched (default 40 products per run) and idempotent —
 * products whose slug already exists are skipped, so it can be re-run until
 * `done` is true:
 *
 *   npx convex run catalogImport:run '{"offset":0}'
 *   npx convex run catalogImport:run '{"offset":40}' ...
 */
export const run = mutation({
  args: {
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const offset = args.offset ?? 0;
    const limit = Math.min(Math.max(args.limit ?? 40, 1), 100);
    const catalog = expandCatalog(TARGET_SKU_COUNT);
    const slice = catalog.slice(offset, offset + limit);
    const t = now();
    const day = 24 * 60 * 60 * 1000;

    const stores = await ensureStores(ctx, t);
    const categoryIds = await ensureCategories(ctx);
    const brandCache = new Map<string, ConvexId<"brands">>();

    const counts = new Map<string, { scope: string; key: string; count: number }>();
    const bump = (scope: string, key: string) => {
      const id = `${scope} ${key}`;
      const row = counts.get(id) ?? { scope, key, count: 0 };
      row.count += 1;
      counts.set(id, row);
    };

    let createdProducts = 0;
    let createdSkus = 0;
    let skipped = 0;

    for (const [i, item] of slice.entries()) {
      const globalIndex = offset + i;
      const slug = slugify(item.name);
      const existing = await ctx.db
        .query("products")
        .withIndex("by_slug", (q: any) => q.eq("slug", slug))
        .first();
      if (existing) {
        skipped += 1;
        continue;
      }
      const categoryId = categoryIds.get(item.cat);
      if (!categoryId) throw new Error(`Unknown catalog category ${item.cat}`);
      const brandId = item.brand
        ? await ensureBrand(ctx, brandCache, item.brand, item.color)
        : undefined;
      const images = placeholderImages(item.name, item.color);
      const ratingCount = 500 + ((globalIndex * 991) % 45000);
      const doc = {
        brand_id: brandId,
        brand: item.brand,
        categoryId,
        primary_category_id: categoryId,
        name: item.name,
        slug,
        description: `${item.brand ? `${item.brand} ` : ""}${item.name} — top quick-commerce SKU in the Philippines.`,
        status: "active" as const,
        tag: item.tag,
        flavour: item.flavour,
        icon_emoji: item.emoji,
        image_color: item.color,
        images,
        temperatureZone: item.zone,
        isFragile: false,
        isFlammable: false,
        isFreshProduce: item.fresh,
        isReturnable: !item.fresh,
        searchKeywords: [item.name.toLowerCase()],
        isExpressAvailable: item.zone !== "frozen",
        isFrequentlyBought: item.frequent,
        rating_average: 4 + ((globalIndex * 37) % 10) / 10,
        rating_count: ratingCount,
        sku_count: 0,
        total_stock: 0,
        productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
        productSearchTokensVersion: PRODUCT_SEARCH_TOKENS_VERSION,
        attributes: [] as { key: string; label: string; value: string }[],
        created_at: t,
        updated_at: t,
      };
      const productId = (await ctx.db.insert("products", doc)) as ConvexId<"products">;
      const tokens = searchTokensForName(item.name);
      for (const token of tokens) {
        await ctx.db.insert("productSearchTokens", {
          product_id: productId,
          token,
          tokens,
          updated_at: t,
          status: "active",
          primary_category_id: categoryId,
          brand_id: brandId,
        });
      }
      for (const [mediaIndex, image] of images.entries()) {
        await ctx.db.insert("product_media", {
          product_id: productId,
          url: image,
          alt_text: `${item.name} image ${mediaIndex + 1}`,
          is_showcase: mediaIndex === 0,
          sort_order: mediaIndex,
        });
      }

      let totalStock = 0;
      let defaultSkuId: ConvexId<"skus"> | undefined;
      let defaultPrice: number | undefined;
      for (const [j, sku] of item.skus.entries()) {
        const isDefault = j === 0;
        const skuId = (await ctx.db.insert("skus", {
          product_id: productId,
          sku_code: sku.code,
          variant_label: sku.label,
          pack_size: sku.label,
          sort_order: j,
          is_default: isDefault,
          is_active: true,
        })) as ConvexId<"skus">;
        bump("skus", skuCountKeys()[0]);
        const priceId = await ctx.db.insert("prices", {
          sku_id: skuId,
          product_id: productId,
          currency: "PHP",
          sale_price: sku.price,
          compare_at_price: sku.compareAt,
          starts_at: t - day,
          priceSummaryVersion: 2,
        });
        await ctx.db.insert("pricesActive", {
          sku_id: skuId,
          price_id: priceId,
          product_id: productId,
          sale_price: sku.price,
          starts_at: t - day,
        });
        if (isDefault) {
          defaultSkuId = skuId;
          defaultPrice = sku.price;
        }
        for (const [storeIndex, store] of stores.entries()) {
          const seedValue = globalIndex * 13 + j * 7 + storeIndex * 5;
          const qty =
            globalIndex % 11 === 0 && storeIndex === 0 ? 0 : 3 + (seedValue % 36);
          totalStock += qty;
          const status = deriveInventoryStatus({
            quantityAvailable: qty,
            lowStockThreshold: 5,
          });
          await ctx.db.insert("inventory", {
            sku_id: skuId,
            store_id: store.id,
            quantity_available: qty,
            quantity_reserved: 0,
            low_stock_threshold: 5,
            status,
            productId,
            skuCode: sku.code,
            variantLabel: sku.label,
            productName: item.name,
            storeName: store.name,
            updated_at: t,
            storeInventorySummaryVersion: 1,
          });
          for (const key of inventoryCountKeys({ status })) {
            bump("inventory", key);
          }
        }
        createdSkus += 1;
      }
      await ctx.db.patch(productId, {
        sku_count: item.skus.length,
        default_sku_id: defaultSkuId,
        default_price: defaultPrice,
        basePrice: defaultPrice,
        total_stock: totalStock,
        productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
      });
      for (const key of productCountKeys({
        status: "active",
        primary_category_id: categoryId,
        brand_id: brandId,
      })) {
        bump("products", key);
      }
      createdProducts += 1;
    }

    for (const row of counts.values()) {
      await bumpListCount(ctx, row.scope as any, row.key, row.count);
    }
    const touched = new Set([...counts.values()].map((row) => row.scope));
    for (const scope of touched) {
      await bumpListCountMutationGeneration(ctx, scope as any);
    }

    const nextOffset = offset + slice.length;
    const done = nextOffset >= catalog.length;
    return {
      done,
      offset,
      processed: slice.length,
      createdProducts,
      createdSkus,
      skipped,
      nextOffset: done ? null : nextOffset,
      catalogProducts: catalog.length,
      catalogSkus: catalog.reduce((sum, p: CatalogProduct) => sum + p.skus.length, 0),
    };
  },
});

/** Quick sanity check on imported catalog volume. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const products = await ctx.db.query("products").collect();
    const skus = await ctx.db.query("skus").collect();
    const categories = await ctx.db.query("categories").collect();
    const brands = await ctx.db.query("brands").collect();
    return {
      products: products.length,
      skus: skus.length,
      categories: categories.length,
      brands: brands.length,
    };
  },
});
