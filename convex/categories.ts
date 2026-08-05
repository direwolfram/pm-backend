import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { now, paginate, slugify } from "./helpers";
import type { CategoryDoc } from "./model";

const CASCADE_BATCH_LIMIT = 100;

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

interface CategoryDbReader {
  get(id: string): Promise<CategoryDoc | null>;
}

const CATEGORY_ANCESTRY_DEPTH_LIMIT = 100;

async function assertNoCategoryCycle(
  ctx: { db: CategoryDbReader },
  categoryId: string,
  parentId?: string,
) {
  const visited = new Set<string>();
  let current = parentId;
  let depth = 0;
  while (current) {
    if (current === categoryId) throw new Error("Category parent would create a cycle");
    if (visited.has(current)) throw new Error("Category ancestry already contains a corrupt cycle");
    if (depth >= CATEGORY_ANCESTRY_DEPTH_LIMIT) throw new Error("Category ancestry exceeds the 100-level safety limit");
    visited.add(current);
    const parent = await ctx.db.get(current);
    if (!parent) throw new Error("Parent category not found");
    if (parent.deleting_at) throw new Error("Parent category is being deleted");
    current = parent.parent_id;
    depth += 1;
  }
}

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
    await assertNoCategoryCycle(ctx, "", args.parent_id);
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
    await assertNoCategoryCycle(ctx, id as string, patch.parent_id);
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

/**
 * SQL behavior: products restrict deletion; children get parent_id set null;
 * home-section items and promotion targets cascade. All phases are bounded,
 * resumable internal continuations.
 */
export const remove = mutation({
  args: { id: v.id("categories") },
  handler: async (ctx, args) => {
    const category = (await ctx.db.get(args.id)) as CategoryDoc | null;
    if (!category) return { id: args.id, deleting: true };
    const product = await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("primary_category_id", args.id))
      .first();
    if (product) {
      throw new Error("Cannot delete: products use this category");
    }
    if (!category.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.categories.continueCategoryDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continueCategoryDelete = internalMutation({
  args: { id: v.id("categories") },
  handler: async (ctx, args) => {
    const category = (await ctx.db.get(args.id)) as CategoryDoc | null;
    if (!category) return { done: true, deleted: true };
    const product = await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("primary_category_id", args.id))
      .first();
    if (product) {
      throw new Error("Cannot delete: products use this category");
    }
    let operations = 0;
    const children = await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parent_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const c of children) {
      await ctx.db.patch(c._id, { parent_id: undefined });
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.categories.continueCategoryDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const items = await ctx.db
      .query("home_section_items")
      .withIndex("by_category", (q) => q.eq("category_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const item of items) {
      await ctx.db.delete(item._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.categories.continueCategoryDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const targets = await ctx.db
      .query("promotion_targets")
      .withIndex("by_category", (q) => q.eq("category_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const t of targets) {
      await ctx.db.delete(t._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.categories.continueCategoryDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await ctx.db.delete(args.id);
    return { done: true, operations };
  },
});
