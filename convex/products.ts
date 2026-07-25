import { v } from "convex/values";
import { query, mutation } from "./functions";
import { now, paginate, slugify } from "./helpers";
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
    const similarPairs = await ctx.db
      .query("product_similar_products")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect();
    const similarIds = similarPairs.map((p) => p.similar_product_id as string);
    const similar: ProductDoc[] = [];
    for (const sid of similarIds) {
      const sp = (await ctx.db.get(sid as any)) as ProductDoc | null;
      if (sp) similar.push(sp);
    }
    const skus = (await ctx.db
      .query("skus")
      .withIndex("by_product", (q) => q.eq("product_id", args.id))
      .collect()) as SkuDoc[];
    skus.sort((a, b) => a.sort_order - b.sort_order);
    const brand = product.brand_id ? await ctx.db.get(product.brand_id as any) : null;
    const category = await ctx.db.get(product.primary_category_id as any);
    return {
      ...product,
      media,
      similar,
      skus,
      brand_name: (brand as { name?: string } | null)?.name,
      category_name: (category as { name?: string } | null)?.name,
    };
  },
});

const productFields = {
  brand_id: v.optional(v.id("brands")),
  primary_category_id: v.id("categories"),
  name: v.string(),
  slug: v.optional(v.string()),
  description: v.optional(v.string()),
  status: v.optional(productStatus),
  tag: v.optional(v.string()),
  pack_type: v.optional(v.string()),
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
      brand_id: args.brand_id,
      primary_category_id: args.primary_category_id,
      name: args.name,
      slug,
      description: args.description,
      status: args.status ?? "draft",
      tag: args.tag,
      pack_type: args.pack_type,
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
    await ctx.db.patch(id, { ...patch, updated_at: now() });
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
    url: v.string(),
    alt_text: v.optional(v.string()),
    dominant_color: v.optional(v.string()),
    sort_order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("product_media", {
      product_id: args.product_id,
      url: args.url,
      alt_text: args.alt_text,
      dominant_color: args.dominant_color,
      sort_order: args.sort_order ?? 0,
    });
  },
});

export const removeMedia = mutation({
  args: { id: v.id("product_media") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
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
