import { v } from "convex/values";
import { query, mutation } from "./functions";
import { now, paginate, slugify } from "./helpers";
import type { Id } from "./_generated/dataModel";
import type {
  InventoryDoc,
  PriceDoc,
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

const dummyProductImageColors = ["F7C948", "90CDF4", "C6F6D5", "FBB6CE"];

function dummyImagesForProduct(name: string) {
  return dummyProductImageColors.map((color, index) => {
    const label = index === 0 ? `${name} Showcase` : `${name} Slide ${index + 1}`;
    return `https://placehold.co/800x800/${color}/111827?text=${encodeURIComponent(label)}`;
  });
}

export const list = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(productStatus),
    category_id: v.optional(v.id("categories")),
    brand_id: v.optional(v.id("brands")),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows: ProductDoc[];
    if (args.search) {
      rows = (await ctx.db
        .query("products")
        .withSearchIndex("search_products", (q) => {
          let s = q.search("name", args.search!);
          if (args.status) s = s.eq("status", args.status);
          if (args.category_id) s = s.eq("primary_category_id", args.category_id);
          if (args.brand_id) s = s.eq("brand_id", args.brand_id);
          return s;
        })
        .collect()) as ProductDoc[];
    } else if (args.category_id) {
      rows = (await ctx.db
        .query("products")
        .withIndex("by_category", (q) => q.eq("primary_category_id", args.category_id!))
        .collect()) as ProductDoc[];
      if (args.status) rows = rows.filter((p) => p.status === args.status);
      if (args.brand_id) rows = rows.filter((p) => p.brand_id === args.brand_id);
    } else if (args.brand_id) {
      rows = (await ctx.db
        .query("products")
        .withIndex("by_brand", (q) => q.eq("brand_id", args.brand_id!))
        .collect()) as ProductDoc[];
      if (args.status) rows = rows.filter((p) => p.status === args.status);
    } else if (args.status) {
      rows = (await ctx.db
        .query("products")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect()) as ProductDoc[];
    } else {
      rows = (await ctx.db.query("products").collect()) as ProductDoc[];
    }

    const [brands, categories, skus, prices, inventory] = await Promise.all([
      ctx.db.query("brands").collect(),
      ctx.db.query("categories").collect(),
      ctx.db.query("skus").collect(),
      ctx.db.query("prices").collect(),
      ctx.db.query("inventory").collect(),
    ]);
    const brandName = new Map(brands.map((b) => [b._id as string, b.name as string]));
    const catName = new Map(categories.map((c) => [c._id as string, c.name as string]));
    const skusByProduct = new Map<string, SkuDoc[]>();
    for (const s of skus as SkuDoc[]) {
      const arr = skusByProduct.get(s.product_id) ?? [];
      arr.push(s);
      skusByProduct.set(s.product_id, arr);
    }
    const priceBySku = new Map<string, PriceDoc[]>();
    for (const p of prices as PriceDoc[]) {
      const arr = priceBySku.get(p.sku_id) ?? [];
      arr.push(p);
      priceBySku.set(p.sku_id, arr);
    }
    const stockBySku = new Map<string, number>();
    for (const i of inventory as InventoryDoc[]) {
      if (i.sku_id === undefined || i.quantity_available === undefined) continue;
      stockBySku.set(i.sku_id, (stockBySku.get(i.sku_id) ?? 0) + i.quantity_available);
    }

    const enriched: ProductListRow[] = rows.map((p) => {
      const pSkus = (skusByProduct.get(p._id) ?? []).sort(
        (a, b) => a.sort_order - b.sort_order,
      );
      const def = pSkus.find((s) => s.is_default) ?? pSkus[0];
      let defaultPrice: number | undefined;
      if (def) {
        const active = (priceBySku.get(def._id) ?? []).filter(
          (pr) => pr.starts_at <= Date.now() && (!pr.ends_at || pr.ends_at > Date.now()),
        );
        const base = active.find((pr) => !pr.store_id) ?? active[0];
        defaultPrice = base?.sale_price;
      }
      const totalStock = pSkus.reduce(
        (sum, s) => sum + (stockBySku.get(s._id) ?? 0),
        0,
      );
      return {
        ...p,
        brand_name: p.brand_id ? brandName.get(p.brand_id) : undefined,
        brand: p.brand,
        category_name: catName.get(p.primary_category_id),
        sku_count: pSkus.length,
        default_sku_id: def?._id,
        default_price: defaultPrice,
        total_stock: totalStock,
      };
    });
    enriched.sort((a, b) => b.updated_at - a.updated_at);
    return paginate(enriched, args);
  },
});

export const get = query({
  args: { id: v.id("products") },
  handler: async (ctx, args) => {
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
    const similarIds = similarPairs.map((p) => p.similar_product_id as string);
    const similar: ProductDoc[] = [];
    for (const sid of similarIds) {
      const sp = (await ctx.db.get(sid as Id<"products">)) as ProductDoc | null;
      if (sp) similar.push(sp);
    }
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
    return await ctx.db.insert("products", {
      sku: args.sku,
      brand_id: args.brand_id,
      categoryId: args.categoryId ?? args.primary_category_id,
      primary_category_id: args.primary_category_id,
      name: args.name,
      slug,
      description: args.description,
      status: args.status ?? "draft",
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
      attributes: args.attributes ?? [],
      created_at: now(),
      updated_at: now(),
    });
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
    await ctx.db.patch(id, {
      ...patch,
      ...(categoryId ? { categoryId } : {}),
      updated_at: now(),
    });
    return id;
  },
});

/** SQL cascade: media, similar pairs, SKUs (+ their prices/inventory). */
export const remove = mutation({
  args: { id: v.id("products") },
  handler: async (ctx, args) => {
    const orderItem = await ctx.db
      .query("order_items")
      .collect()
      .then((rows) => rows.find((r) => r.product_id === args.id));
    if (orderItem) {
      throw new Error(
        "Cannot delete: this product appears in orders. Set status to discontinued instead.",
      );
    }
    const media = await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect();
    for (const m of media) await ctx.db.delete(m._id);

    const pairs = await ctx.db.query("product_similar_products").collect();
    for (const p of pairs) {
      if (p.product_id === args.id || p.similar_product_id === args.id) {
        await ctx.db.delete(p._id);
      }
    }
    const skus = await ctx.db
      .query("skus")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect();
    for (const s of skus) {
      const prices = await ctx.db
        .query("prices")
        .withIndex("by_sku", (q) => q.eq("sku_id", s._id))
        .collect();
      for (const pr of prices) await ctx.db.delete(pr._id);
      const inv = await ctx.db
        .query("inventory")
        .withIndex("by_sku", (q) => q.eq("sku_id", s._id))
        .collect();
      for (const i of inv) await ctx.db.delete(i._id);
      await ctx.db.delete(s._id);
    }
    const items = await ctx.db.query("home_section_items").collect();
    for (const item of items) {
      if (item.product_id === args.id) await ctx.db.delete(item._id);
    }
    const targets = await ctx.db.query("promotion_targets").collect();
    for (const t of targets) {
      if (t.product_id === args.id) await ctx.db.delete(t._id);
    }
    await ctx.db.delete(args.id);
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
    const existing = await ctx.db
      .query("product_similar_products")
      .withIndex("by_product", (q) => q.eq("product_id", args.product_id))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    for (const sid of args.similar_product_ids) {
      if (sid === args.product_id) continue;
      await ctx.db.insert("product_similar_products", {
        product_id: args.product_id,
        similar_product_id: sid,
      });
    }
  },
});
