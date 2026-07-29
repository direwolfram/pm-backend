import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedBase(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    });
    const storeA = await ctx.db.insert("stores", {
      name: "Store A",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    });
    const storeB = await ctx.db.insert("stores", {
      name: "Store B",
      status: "active",
      address: "B",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: `Cascade Product ${Math.random()}`,
      slug: `cascade-${Math.random()}`,
      status: "active",
      rating_average: 0,
      rating_count: 0,
      sku_count: 0,
      total_stock: 0,
      productListSummaryVersion: 2,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    return { categoryId, storeA, storeB, productId };
  });
}

async function activeMirrors(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("pricesActive").collect());
}

async function allPrices(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("prices").collect());
}

async function getProduct(t: ReturnType<typeof convexTest>, productId: Id<"products">) {
  return await t.run(async (ctx) => await ctx.db.get(productId));
}

describe("store cascade price-mirror invariants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves base and surviving-store mirrors, precedence, default_price, and total_stock", async () => {
    const t = convexTest({ schema, modules });
    const { storeA, storeB, productId } = await seedBase(t);
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "MIX-1",
      variant_label: "V",
      is_default: true,
    });
    // base (9) beats both store prices; store B (6) must survive the cascade
    const basePriceId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 9,
      starts_at: Date.now() - 1_000,
    });
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeA,
      sale_price: 5,
      starts_at: Date.now() - 1_000,
    });
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeB,
      sale_price: 6,
      starts_at: Date.now() - 1_000,
    });
    await t.mutation(api.inventory.upsert, {
      sku_id: skuId,
      store_id: storeA,
      quantity_available: 40,
    });
    await t.mutation(api.inventory.upsert, {
      sku_id: skuId,
      store_id: storeB,
      quantity_available: 10,
    });
    expect((await getProduct(t, productId))?.default_price).toBe(9);
    expect((await getProduct(t, productId))?.total_stock).toBe(50);
    expect(await activeMirrors(t)).toHaveLength(3);

    await t.mutation(api.stores.remove, { id: storeA });

    // late references to the deleting root are rejected
    await expect(
      t.mutation(api.prices.upsert, {
        sku_id: skuId,
        store_id: storeA,
        sale_price: 7,
        starts_at: Date.now() - 1_000,
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.inventory.upsert, {
        sku_id: skuId,
        store_id: storeA,
        quantity_available: 5,
      }),
    ).rejects.toThrow(/being deleted/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // only store A's price and mirror are gone
    const prices = await allPrices(t);
    expect(prices).toHaveLength(2);
    expect(prices.every((p) => p.store_id !== storeA)).toBe(true);
    const mirrors = await activeMirrors(t);
    expect(mirrors).toHaveLength(2);
    expect(mirrors.map((m) => m.price_id).sort()).toEqual(
      prices.map((p) => p._id).sort(),
    );
    expect(mirrors.some((m) => m.store_id === storeA)).toBe(false);

    // base precedence intact, stock reduced exactly by store A's 40 units
    const product = await getProduct(t, productId);
    expect(product?.default_price).toBe(9);
    expect(product?.total_stock).toBe(10);

    // removing the base price falls back to the single surviving store price
    await t.mutation(api.prices.remove, { id: basePriceId });
    expect((await getProduct(t, productId))?.default_price).toBe(6);
    expect(await activeMirrors(t)).toHaveLength(1);

    // continuing an already-deleted root is a no-op
    const again = await t.mutation(internal.stores.continueStoreDelete, {
      id: storeA,
    });
    expect(again).toMatchObject({ done: true });
  });

  it("stays exact across multi-batch prices and inventory with duplicate continuations", async () => {
    const t = convexTest({ schema, modules });
    const { storeA, storeB, productId } = await seedBase(t);
    const SKU_COUNT = 105; // crosses the 100-op cascade batch limit twice
    let defaultSkuId: Id<"skus"> | null = null;
    for (let index = 0; index < SKU_COUNT; index += 1) {
      const skuId = await t.mutation(api.skus.create, {
        product_id: productId,
        sku_code: `BULK-${index}`,
        variant_label: "V",
        is_default: index === 0,
      });
      if (index === 0) defaultSkuId = skuId;
      await t.mutation(api.prices.upsert, {
        sku_id: skuId,
        sale_price: 9,
        starts_at: Date.now() - 1_000,
      });
      await t.mutation(api.prices.upsert, {
        sku_id: skuId,
        store_id: storeA,
        sale_price: 5,
        starts_at: Date.now() - 1_000,
      });
      await t.mutation(api.prices.upsert, {
        sku_id: skuId,
        store_id: storeB,
        sale_price: 6,
        starts_at: Date.now() - 1_000,
      });
      await t.mutation(api.inventory.upsert, {
        sku_id: skuId,
        store_id: storeA,
        quantity_available: 1,
      });
      await t.mutation(api.inventory.upsert, {
        sku_id: skuId,
        store_id: storeB,
        quantity_available: 2,
      });
    }
    expect((await getProduct(t, productId))?.total_stock).toBe(SKU_COUNT * 3);
    expect(await activeMirrors(t)).toHaveLength(SKU_COUNT * 3);

    await t.mutation(api.stores.remove, { id: storeA });

    // duplicate manual continuations interleaved with the scheduled drain:
    // each batch applies its exact per-row delta transactionally, so
    // overlapping progress cannot double-decrement stock or double-delete.
    await t.mutation(internal.stores.continueStoreDelete, { id: storeA });
    await t.mutation(internal.stores.continueStoreDelete, { id: storeA });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.stores.continueStoreDelete, { id: storeA });

    const prices = await allPrices(t);
    expect(prices).toHaveLength(SKU_COUNT * 2);
    expect(prices.every((p) => p.store_id !== storeA)).toBe(true);
    const mirrors = await activeMirrors(t);
    expect(mirrors).toHaveLength(SKU_COUNT * 2);
    expect(new Set(mirrors.map((m) => m.price_id))).toEqual(
      new Set(prices.map((p) => p._id)),
    );

    const product = await getProduct(t, productId);
    expect(product?.total_stock).toBe(SKU_COUNT * 2);
    expect(product?.default_price).toBe(9);
    expect(product?.sku_count).toBe(SKU_COUNT);
    void defaultSkuId;
    await expect(
      t.run(async (ctx) => await ctx.db.get(storeA)),
    ).resolves.toBeNull();

    // already-deleted root: fully idempotent
    const again = await t.mutation(internal.stores.continueStoreDelete, {
      id: storeA,
    });
    expect(again).toMatchObject({ done: true, deleted: true });
    expect((await getProduct(t, productId))?.total_stock).toBe(SKU_COUNT * 2);
  });
});
