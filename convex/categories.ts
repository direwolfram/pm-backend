import { v } from "convex/values";
import { query, mutation } from "./functions";
import { paginate, slugify } from "./helpers";
import type { CategoryDoc } from "./model";

export const list = query({
  args: {
    includeInactive: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("categories").collect()) as CategoryDoc[];
    if (!args.includeInactive) rows = rows.filter((c) => c.is_active);
    const products = await ctx.db.query("products").collect();
    const counts = new Map<string, number>();
    for (const p of products as { primary_category_id: string }[]) {
      counts.set(
        p.primary_category_id,
        (counts.get(p.primary_category_id) ?? 0) + 1,
      );
    }
    const byId = new Map(rows.map((c) => [c._id, c]));
    const enriched = rows
      .map((c) => ({
        ...c,
        parent_name: c.parent_id ? byId.get(c.parent_id)?.name : undefined,
        product_count: counts.get(c._id) ?? 0,
      }))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    return paginate(enriched, args);
  },
});

const categoryFields = {
  parent_id: v.optional(v.id("categories")),
  name: v.string(),
  slug: v.optional(v.string()),
  section_name: v.optional(v.string()),
  image_url: v.optional(v.string()),
  icon_emoji: v.optional(v.string()),
  background_color: v.optional(v.string()),
  image_color: v.optional(v.string()),
  sort_order: v.optional(v.number()),
  is_active: v.optional(v.boolean()),
};

export const create = mutation({
  args: categoryFields,
  handler: async (ctx, args) => {
    const slug = args.slug?.trim() || slugify(args.name);
    if (!slug) throw new Error("Category needs a name or slug");
    const dup = await ctx.db
      .query("categories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (dup) throw new Error(`Slug "${slug}" is already used`);
    if (args.parent_id) {
      const parent = await ctx.db.get(args.parent_id);
      if (!parent) throw new Error("Parent category not found");
    }
    return await ctx.db.insert("categories", {
      parent_id: args.parent_id,
      name: args.name,
      slug,
      section_name: args.section_name,
      image_url: args.image_url,
      icon_emoji: args.icon_emoji,
      background_color: args.background_color,
      image_color: args.image_color,
      sort_order: args.sort_order ?? 0,
      is_active: args.is_active ?? true,
    });
  },
});

export const update = mutation({
  args: { id: v.id("categories"), ...categoryFields, name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const cat = await ctx.db.get(id);
    if (!cat) throw new Error("Category not found");
    if (patch.parent_id === id) throw new Error("A category cannot be its own parent");
    if (patch.slug && patch.slug !== cat.slug) {
      const dup = await ctx.db
        .query("categories")
        .withIndex("by_slug", (q) => q.eq("slug", patch.slug!))
        .first();
      if (dup) throw new Error(`Slug "${patch.slug}" is already used`);
    }
    await ctx.db.patch(id, patch);
    return id;
  },
});

/** SQL behavior: children get parent_id set null; blocked if products exist. */
export const remove = mutation({
  args: { id: v.id("categories") },
  handler: async (ctx, args) => {
    const products = await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("primary_category_id", args.id))
      .collect();
    if (products.length > 0) {
      throw new Error(
        `Cannot delete: ${products.length} product(s) use this category`,
      );
    }
    const children = await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parent_id", args.id))
      .collect();
    for (const c of children) {
      await ctx.db.patch(c._id, { parent_id: undefined });
    }
    const items = await ctx.db.query("home_section_items").collect();
    for (const item of items) {
      if (item.category_id === args.id) await ctx.db.delete(item._id);
    }
    const targets = await ctx.db.query("promotion_targets").collect();
    for (const t of targets) {
      if (t.category_id === args.id) await ctx.db.delete(t._id);
    }
    await ctx.db.delete(args.id);
  },
});
