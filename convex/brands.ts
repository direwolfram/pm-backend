import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { now, paginate } from "./helpers";
import type { BrandDoc } from "./model";

const CASCADE_BATCH_LIMIT = 100;

export const list = query({
  args: {
    search: v.optional(v.string()),
    includeInactive: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("brands").collect()) as BrandDoc[];
    if (!args.includeInactive) rows = rows.filter((b) => b.is_active);
    if (args.search) {
      const s = args.search.toLowerCase();
      rows = rows.filter((b) => b.name.toLowerCase().includes(s));
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    // attach product counts
    const products = await ctx.db.query("products").collect();
    const counts = new Map<string, number>();
    for (const p of products as { brand_id?: string }[]) {
      if (p.brand_id) counts.set(p.brand_id, (counts.get(p.brand_id) ?? 0) + 1);
    }
    const enriched = rows.map((b) => ({
      ...b,
      product_count: counts.get(b._id) ?? 0,
    }));
    return paginate(enriched, args);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    logo_url: v.optional(v.string()),
    logo_color: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("brands")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (existing) throw new Error(`Brand "${args.name}" already exists`);
    return await ctx.db.insert("brands", {
      name: args.name,
      logo_url: args.logo_url,
      logo_color: args.logo_color,
      is_active: args.is_active ?? true,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("brands"),
    name: v.optional(v.string()),
    logo_url: v.optional(v.string()),
    logo_color: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const brand = await ctx.db.get(id);
    if (!brand) throw new Error("Brand not found");
    if (patch.name && patch.name !== brand.name) {
      const dup = await ctx.db
        .query("brands")
        .withIndex("by_name", (q) => q.eq("name", patch.name!))
        .first();
      if (dup) throw new Error(`Brand "${patch.name}" already exists`);
    }
    await ctx.db.patch(id, patch);
    return id;
  },
});

/**
 * SQL behavior: products.brand_id references brands on delete set null;
 * promotion targets cascade. Bounded, resumable internal continuation.
 */
export const remove = mutation({
  args: { id: v.id("brands") },
  handler: async (ctx, args) => {
    const brand = (await ctx.db.get(args.id)) as BrandDoc | null;
    if (!brand) return { id: args.id, deleting: true };
    if (!brand.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.brands.continueBrandDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continueBrandDelete = internalMutation({
  args: { id: v.id("brands") },
  handler: async (ctx, args) => {
    const brand = (await ctx.db.get(args.id)) as BrandDoc | null;
    if (!brand) return { done: true, deleted: true };
    let operations = 0;
    const products = await ctx.db
      .query("products")
      .withIndex("by_brand", (q) => q.eq("brand_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const p of products) {
      await ctx.db.patch(p._id, { brand_id: undefined });
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.brands.continueBrandDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const targets = await ctx.db
      .query("promotion_targets")
      .withIndex("by_brand", (q) => q.eq("brand_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const t of targets) {
      await ctx.db.delete(t._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.brands.continueBrandDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await ctx.db.delete(args.id);
    return { done: true, operations };
  },
});
