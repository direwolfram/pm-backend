import { v } from "convex/values";
import { query, mutation } from "./functions";
import type {
  CategoryDoc,
  HomeSectionDoc,
  HomeSectionItemDoc,
  ProductDoc,
  PromotionDoc,
} from "./model";

const sectionKind = v.union(
  v.literal("product_carousel"),
  v.literal("category_grid"),
  v.literal("bestseller_grid"),
  v.literal("promo_banner"),
  v.literal("shopping_list_card"),
);

export const list = query({
  args: { tab: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("home_sections").collect()) as HomeSectionDoc[];
    if (args.tab) rows = rows.filter((s) => s.tab === args.tab);
    rows.sort((a, b) => a.sort_order - b.sort_order);
    const items = (await ctx.db
      .query("home_section_items")
      .collect()) as HomeSectionItemDoc[];
    const products = new Map(
      ((await ctx.db.query("products").collect()) as ProductDoc[]).map((p) => [
        p._id,
        p,
      ]),
    );
    const categories = new Map(
      ((await ctx.db.query("categories").collect()) as CategoryDoc[]).map((c) => [
        c._id,
        c,
      ]),
    );
    const promotions = new Map(
      ((await ctx.db.query("promotions").collect()) as PromotionDoc[]).map((p) => [
        p._id,
        p,
      ]),
    );
    return rows.map((s) => ({
      ...s,
      items: items
        .filter((i) => i.section_id === s._id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((i) => ({
          ...i,
          label: i.product_id
            ? (products.get(i.product_id)?.name ?? "(missing product)")
            : i.category_id
              ? (categories.get(i.category_id)?.name ?? "(missing category)")
              : (promotions.get(i.promotion_id ?? "")?.title ?? "(missing promotion)"),
          item_type: i.product_id
            ? "product"
            : i.category_id
              ? "category"
              : "promotion",
        })),
    }));
  },
});

export const tabs = query({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("home_sections").collect()) as HomeSectionDoc[];
    return Array.from(new Set(rows.map((r) => r.tab))).sort();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    kind: sectionKind,
    tab: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("home_sections", {
      title: args.title,
      kind: args.kind,
      tab: args.tab ?? "All",
      sort_order: args.sort_order ?? 0,
      is_active: args.is_active ?? true,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("home_sections"),
    title: v.optional(v.string()),
    kind: v.optional(sectionKind),
    tab: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const section = await ctx.db.get(id);
    if (!section) throw new Error("Home section not found");
    await ctx.db.patch(id, patch);
    return id;
  },
});

export const setItems = mutation({
  args: {
    section_id: v.id("home_sections"),
    items: v.array(
      v.object({
        product_id: v.optional(v.id("products")),
        category_id: v.optional(v.id("categories")),
        promotion_id: v.optional(v.id("promotions")),
        sort_order: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("home_section_items")
      .withIndex("by_section", (q) => q.eq("section_id", args.section_id))
      .collect();
    for (const i of existing) await ctx.db.delete(i._id);
    for (const item of args.items) {
      if (!item.product_id && !item.category_id && !item.promotion_id) {
        throw new Error("Each item must reference a product, category, or promotion");
      }
      await ctx.db.insert("home_section_items", {
        section_id: args.section_id,
        ...item,
      });
    }
  },
});

export const remove = mutation({
  args: { id: v.id("home_sections") },
  handler: async (ctx, args) => {
    const items = await ctx.db
      .query("home_section_items")
      .withIndex("by_section", (q) => q.eq("section_id", args.id))
      .collect();
    for (const i of items) await ctx.db.delete(i._id);
    await ctx.db.delete(args.id);
  },
});
