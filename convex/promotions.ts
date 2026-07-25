import { v } from "convex/values";
import { query, mutation } from "./functions";
import { paginate } from "./helpers";
import type { PromotionDoc, PromotionTargetDoc } from "./model";

const promotionKind = v.union(
  v.literal("banner"),
  v.literal("carousel"),
  v.literal("coupon"),
  v.literal("product_discount"),
);
const discountType = v.union(
  v.literal("percent"),
  v.literal("fixed"),
  v.literal("free_delivery"),
);

export const list = query({
  args: {
    kind: v.optional(promotionKind),
    activeOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("promotions").collect()) as PromotionDoc[];
    if (args.kind) rows = rows.filter((p) => p.kind === args.kind);
    if (args.activeOnly) {
      const t = Date.now();
      rows = rows.filter(
        (p) => p.is_active && p.starts_at <= t && p.ends_at > t,
      );
    }
    const targets = (await ctx.db
      .query("promotion_targets")
      .collect()) as PromotionTargetDoc[];
    const enriched = rows.map((p) => ({
      ...p,
      target_count: targets.filter((t) => t.promotion_id === p._id).length,
      is_running: p.is_active && p.starts_at <= Date.now() && p.ends_at > Date.now(),
    }));
    enriched.sort((a, b) => b.starts_at - a.starts_at);
    return paginate(enriched, args);
  },
});

export const get = query({
  args: { id: v.id("promotions") },
  handler: async (ctx, args) => {
    const promo = (await ctx.db.get(args.id)) as PromotionDoc | null;
    if (!promo) throw new Error("Promotion not found");
    const targets = (await ctx.db
      .query("promotion_targets")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.id))
      .collect()) as PromotionTargetDoc[];
    return { ...promo, targets };
  },
});

const promotionFields = {
  kind: promotionKind,
  title: v.string(),
  subtitle: v.optional(v.string()),
  description: v.optional(v.string()),
  image_url: v.optional(v.string()),
  background_color: v.optional(v.string()),
  discount_type: v.optional(discountType),
  discount_value: v.optional(v.number()),
  coupon_code: v.optional(v.string()),
  minimum_order_amount: v.optional(v.number()),
  max_discount_amount: v.optional(v.number()),
  starts_at: v.number(),
  ends_at: v.number(),
  is_active: v.optional(v.boolean()),
};

function validateWindow(startsAt: number, endsAt: number) {
  if (endsAt <= startsAt) throw new Error("ends_at must be after starts_at");
}

async function assertUniqueCoupon(
  ctx: { db: any },
  code: string,
  excludeId?: string,
) {
  const dup = await ctx.db
    .query("promotions")
    .withIndex("by_coupon_code", (q: any) => q.eq("coupon_code", code))
    .first();
  if (dup && dup._id !== excludeId) {
    throw new Error(`Coupon code "${code}" is already used`);
  }
}

export const create = mutation({
  args: {
    ...promotionFields,
    targets: v.optional(
      v.array(
        v.object({
          product_id: v.optional(v.id("products")),
          sku_id: v.optional(v.id("skus")),
          category_id: v.optional(v.id("categories")),
          brand_id: v.optional(v.id("brands")),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    validateWindow(args.starts_at, args.ends_at);
    if (args.coupon_code) await assertUniqueCoupon(ctx, args.coupon_code);
    const id = await ctx.db.insert("promotions", {
      kind: args.kind,
      title: args.title,
      subtitle: args.subtitle,
      description: args.description,
      image_url: args.image_url,
      background_color: args.background_color,
      discount_type: args.discount_type,
      discount_value: args.discount_value,
      coupon_code: args.coupon_code,
      minimum_order_amount: args.minimum_order_amount,
      max_discount_amount: args.max_discount_amount,
      currency: "PHP",
      starts_at: args.starts_at,
      ends_at: args.ends_at,
      is_active: args.is_active ?? true,
    });
    for (const t of args.targets ?? []) {
      if (!t.product_id && !t.sku_id && !t.category_id && !t.brand_id) continue;
      await ctx.db.insert("promotion_targets", { promotion_id: id, ...t });
    }
    return id;
  },
});

export const update = mutation({
  args: {
    id: v.id("promotions"),
    kind: v.optional(promotionKind),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    description: v.optional(v.string()),
    image_url: v.optional(v.string()),
    background_color: v.optional(v.string()),
    discount_type: v.optional(discountType),
    discount_value: v.optional(v.number()),
    coupon_code: v.optional(v.string()),
    minimum_order_amount: v.optional(v.number()),
    max_discount_amount: v.optional(v.number()),
    starts_at: v.optional(v.number()),
    ends_at: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const promo = (await ctx.db.get(id)) as PromotionDoc | null;
    if (!promo) throw new Error("Promotion not found");
    validateWindow(
      patch.starts_at ?? promo.starts_at,
      patch.ends_at ?? promo.ends_at,
    );
    if (patch.coupon_code && patch.coupon_code !== promo.coupon_code) {
      await assertUniqueCoupon(ctx, patch.coupon_code, id as string);
    }
    await ctx.db.patch(id, patch);
    return id;
  },
});

export const setTargets = mutation({
  args: {
    promotion_id: v.id("promotions"),
    targets: v.array(
      v.object({
        product_id: v.optional(v.id("products")),
        sku_id: v.optional(v.id("skus")),
        category_id: v.optional(v.id("categories")),
        brand_id: v.optional(v.id("brands")),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("promotion_targets")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.promotion_id))
      .collect();
    for (const t of existing) await ctx.db.delete(t._id);
    for (const t of args.targets) {
      if (!t.product_id && !t.sku_id && !t.category_id && !t.brand_id) {
        throw new Error("Each target must reference a product, SKU, category, or brand");
      }
      await ctx.db.insert("promotion_targets", {
        promotion_id: args.promotion_id,
        ...t,
      });
    }
  },
});

export const remove = mutation({
  args: { id: v.id("promotions") },
  handler: async (ctx, args) => {
    const targets = await ctx.db
      .query("promotion_targets")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.id))
      .collect();
    for (const t of targets) await ctx.db.delete(t._id);
    const items = await ctx.db.query("home_section_items").collect();
    for (const item of items) {
      if (item.promotion_id === args.id) await ctx.db.delete(item._id);
    }
    await ctx.db.delete(args.id);
  },
});
