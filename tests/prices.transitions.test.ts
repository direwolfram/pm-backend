import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedProductWithSku(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: "Transition Product",
      slug: `transition-product-${Math.random()}`,
      status: "active",
      rating_average: 0,
      rating_count: 0,
      sku_count: 1,
      total_stock: 0,
      productListSummaryVersion: 2,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    const skuId = await ctx.db.insert("skus", {
      product_id: productId,
      sku_code: `TR-${Math.random()}`,
      variant_label: "V",
      sort_order: 0,
      is_default: true,
      is_active: true,
    });
    await ctx.db.patch(productId, { default_sku_id: skuId });
    const storeId = await ctx.db.insert("stores", {
      name: "Store",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    });
    return { productId, skuId, storeId };
  });
}

async function insertPrices(
  t: ReturnType<typeof convexTest>,
  skuId: Id<"skus">,
  productId: Id<"products">,
  count: number,
  opts: { startsAt: (i: number) => number; endsAt?: (i: number) => number | undefined; storeId?: Id<"stores">; price?: (i: number) => number },
) {
  await t.run(async (ctx) => {
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("prices", {
        sku_id: skuId,
        product_id: productId,
        store_id: opts.storeId,
        currency: "PHP",
        sale_price: opts.price?.(index) ?? 10,
        starts_at: opts.startsAt(index),
        ends_at: opts.endsAt?.(index),
        priceSummaryVersion: 2,
      });
    }
  });
}

async function mirrorRows(t: ReturnType<typeof convexTest>, skuId: Id<"skus">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("pricesActive")
      .withIndex("by_sku", (q) => q.eq("sku_id", skuId))
      .collect(),
  );
}

describe("price transition drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains more than 200 simultaneous activations across continuations", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    const startsAt = Date.now() + 3_600_000;
    await insertPrices(t, skuId, productId, 250, {
      startsAt: () => startsAt,
      price: () => 10,
    });
    // one later-starting price wins deterministically
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => startsAt + 1_000,
      price: () => 77,
    });

    vi.setSystemTime(Date.now() + 7_200_000);
    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.drained).toBe(false);
    expect(first.remainingMayExist).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(251);
    // unique per price
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(251);

    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(77);

    // a repeated cron run is a no-op
    const again = await t.mutation(internal.prices.scheduleTransition, {});
    expect(again).toMatchObject({ expired: 0, activated: 0, drained: true });
  });

  it("drains more than 200 expirations and stops them contributing", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 230, {
      startsAt: () => Date.now() - 10_000,
      endsAt: () => Date.now() + 3_600_000,
      price: () => 5,
    });
    // one persistent base price
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 10_000,
      price: () => 9,
    });
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mirrorRows(t, skuId)).toHaveLength(231);

    // all 230 expire
    vi.setSystemTime(Date.now() + 3_600_000 + 1);
    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.expired).toBe(200);
    expect(first.drained).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(1);
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(9);
  });

  it("resumes an interrupted drain instead of starting over", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 450, {
      startsAt: () => Date.now() - 1_000,
      price: () => 3,
    });

    // Overlapping root runs before draining share one logical chain.
    const a = await t.mutation(internal.prices.scheduleTransition, {});
    const b = await t.mutation(internal.prices.scheduleTransition, {});
    expect(a.drained).toBe(false);
    expect(b.drained).toBe(false);
    const syncedTotal = a.activated + b.activated;
    expect(syncedTotal).toBeGreaterThan(200);
    expect(syncedTotal).toBeLessThanOrEqual(450);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(450);
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(450);
  });

  it("keeps mirrors consistent when prices are edited during the drain", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 250, {
      startsAt: () => Date.now() - 1_000,
      price: () => 3,
    });

    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.drained).toBe(false);

    // edit + insert mid-drain through the public mutation
    const editedId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeId,
      sale_price: 55,
      starts_at: Date.now() - 500,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    const edited = mirrors.find((m) => m.price_id === editedId);
    expect(edited).toMatchObject({ sale_price: 55, store_id: storeId });
    // base prices win over the single store price
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(3);

    // removing the price removes its mirror
    await t.mutation(api.prices.remove, { id: editedId });
    const after = await mirrorRows(t, skuId);
    expect(after.find((m) => m.price_id === editedId)).toBeUndefined();
  });

  it("preserves base-over-store precedence and single-store fallback", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 1_000,
      storeId,
      price: () => 5,
    });
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(5);

    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 900,
      price: () => 8,
    });
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(8);
  });
});
