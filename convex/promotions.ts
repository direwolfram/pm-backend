import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { now } from "./helpers";
import type { PromotionDoc, PromotionTargetDoc } from "./model";

const CASCADE_BATCH_LIMIT = 100;
const PROMOTION_PAGE_LIMIT = 100;
const PROMOTION_OFFSET_LIMIT = 500;

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
  args: { kind: v.optional(promotionKind), activeOnly: v.optional(v.boolean()), limit: v.optional(v.number()), offset: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PROMOTION_PAGE_LIMIT);
    const offset = Math.min(Math.max(args.offset ?? 0, 0), PROMOTION_OFFSET_LIMIT);
    const t = Date.now();
    const queryBuilder = args.kind
      ? ctx.db.query("promotions").withIndex("by_kind_starts", (q: any) => q.eq("kind", args.kind!))
      : args.activeOnly
        ? ctx.db.query("promotions").withIndex("by_active_starts", (q: any) => q.eq("is_active", true).lte("starts_at", t))
        : ctx.db.query("promotions").withIndex("by_active_starts");
    const candidates = (await queryBuilder.order("desc").take(offset + limit + 1)) as PromotionDoc[];
    const filtered = args.activeOnly ? candidates.filter((p) => p.is_active && p.starts_at <= t && p.ends_at > t) : candidates;
    const page = filtered.slice(offset, offset + limit);
    const data = await Promise.all(page.map(async (promotion) => {
      const targets = await ctx.db.query("promotion_targets").withIndex("by_promotion", (q: any) => q.eq("promotion_id", promotion._id)).take(CASCADE_BATCH_LIMIT + 1);
      if (targets.length > CASCADE_BATCH_LIMIT) throw new Error("Promotion target count exceeds the supported bound");
      return { ...promotion, target_count: targets.length, is_running: promotion.is_active && promotion.starts_at <= t && promotion.ends_at > t };
    }));
    return { data, total: offset + filtered.length + (candidates.length > offset + limit ? 1 : 0), limit, offset, hasMore: candidates.length > offset + limit };
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

async function assertTargetWritable(ctx: { db: any }, target: {
  product_id?: string;
  sku_id?: string;
  category_id?: string;
  brand_id?: string;
}) {
  for (const id of [
    target.product_id,
    target.sku_id,
    target.category_id,
    target.brand_id,
  ].filter(Boolean)) {
    const doc = await ctx.db.get(id as string);
    if (!doc) throw new Error("Promotion target reference not found");
    if ((doc as { deleting_at?: number }).deleting_at) {
      throw new Error("Promotion target is being deleted");
    }
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
    if ((args.targets?.length ?? 0) > CASCADE_BATCH_LIMIT) throw new Error(`A promotion can have at most ${CASCADE_BATCH_LIMIT} targets`);
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
      await assertTargetWritable(ctx, t);
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
    // Hard cardinality cap keeps replacement a single bounded transaction.
    if (args.targets.length > CASCADE_BATCH_LIMIT) {
      throw new Error(
        `A promotion can have at most ${CASCADE_BATCH_LIMIT} targets per update`,
      );
    }
    const existing = await ctx.db
      .query("promotion_targets")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.promotion_id))
      .take(CASCADE_BATCH_LIMIT + 1);
    if (existing.length > CASCADE_BATCH_LIMIT) {
      throw new Error(
        "Promotion has too many existing targets; remove them first",
      );
    }
    for (const t of existing) await ctx.db.delete(t._id);
    for (const t of args.targets) {
      if (!t.product_id && !t.sku_id && !t.category_id && !t.brand_id) {
        throw new Error("Each target must reference a product, SKU, category, or brand");
      }
      await assertTargetWritable(ctx, t);
      await ctx.db.insert("promotion_targets", {
        promotion_id: args.promotion_id,
        ...t,
      });
    }
  },
});

/**
 * Cascade: promotion targets and home-section items go with the promotion.
 * Bounded, resumable internal continuation.
 */
export const remove = mutation({
  args: { id: v.id("promotions") },
  handler: async (ctx, args) => {
    const promotion = (await ctx.db.get(args.id)) as PromotionDoc | null;
    if (!promotion) return { id: args.id, deleting: true };
    if (!promotion.deleting_at) {
      await ctx.db.patch(args.id, { deleting_at: now() });
    }
    await ctx.scheduler.runAfter(0, anyApi.promotions.continuePromotionDelete, {
      id: args.id,
    });
    return { id: args.id, deleting: true };
  },
});

export const continuePromotionDelete = internalMutation({
  args: { id: v.id("promotions") },
  handler: async (ctx, args) => {
    const promotion = (await ctx.db.get(args.id)) as PromotionDoc | null;
    if (!promotion) return { done: true, deleted: true };
    let operations = 0;
    const targets = await ctx.db
      .query("promotion_targets")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.id))
      .take(CASCADE_BATCH_LIMIT);
    for (const t of targets) {
      await ctx.db.delete(t._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.promotions.continuePromotionDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    const items = await ctx.db
      .query("home_section_items")
      .withIndex("by_promotion", (q) => q.eq("promotion_id", args.id))
      .take(CASCADE_BATCH_LIMIT - operations);
    for (const item of items) {
      await ctx.db.delete(item._id);
      operations += 1;
    }
    if (operations >= CASCADE_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.promotions.continuePromotionDelete, {
        id: args.id,
      });
      return { done: false, operations };
    }
    await ctx.db.delete(args.id);
    return { done: true, operations };
  },
});
