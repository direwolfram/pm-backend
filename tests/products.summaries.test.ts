import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedCatalog(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: "cat",
      sort_order: 1,
      is_active: true,
    });
    const brandId = await ctx.db.insert("brands", {
      name: "Brand",
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      brand_id: brandId,
      name: "Summary Product",
      slug: "summary-product",
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
    return { categoryId, brandId, productId, storeId };
  });
}

async function getProduct(
  t: ReturnType<typeof convexTest>,
  productId: Id<"products">,
) {
  return await t.run(async (ctx) => await ctx.db.get(productId));
}

describe("product list summaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts more than 500 SKUs and 1000 inventory rows exactly", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedCatalog(t);
    await t.run(async (ctx) => {
      let expectedStock = 0;
      for (let index = 0; index < 505; index += 1) {
        const skuId = await ctx.db.insert("skus", {
          product_id: productId,
          sku_code: `BULK-${index}`,
          variant_label: `V${index}`,
          sort_order: index,
          is_default: index === 0,
          is_active: true,
        });
        for (const qty of [1, 2]) {
          expectedStock += qty;
          await ctx.db.insert("inventory", {
            sku_id: skuId,
            store_id: undefined,
            quantity_available: qty,
            quantity_reserved: 0,
            low_stock_threshold: 0,
            status: "in_stock",
            productId,
            updated_at: 1,
          });
        }
      }
      // corrupt the stored summary and mark it stale
      await ctx.db.patch(productId, {
        sku_count: 1,
        total_stock: 1,
        productListSummaryVersion: 1,
      });
      void expectedStock;
    });

    const result = await t.mutation(
      internal.products.backfillProductListSummaries,
      { limit: 50 },
    );
    expect(result.processed).toBe(1);
    expect(result.patched).toBe(1);

    await expect(getProduct(t, productId)).resolves.toMatchObject({
      sku_count: 505,
      total_stock: 505 * 3,
      productListSummaryVersion: 2,
    });

    // duplicate execution is a no-op
    const again = await t.mutation(
      internal.products.backfillProductListSummaries,
      { limit: 50 },
    );
    expect(again.processed).toBe(0);
  });

  it("selects the active base price beyond 50 historical prices", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedCatalog(t);
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "HIST-1",
      variant_label: "V",
      is_default: true,
    });
    await t.run(async (ctx) => {
      // 60 expired historical prices; none should be considered active.
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert("prices", {
          sku_id: skuId,
          product_id: productId,
          currency: "PHP",
          sale_price: 1000 + index,
          starts_at: 1 + index,
          ends_at: 2 + index,
          priceSummaryVersion: 2,
        });
      }
    });
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 42,
      starts_at: Date.now() - 1_000,
    });

    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 42,
    });
  });

  it("activates a future price and expires an ended price via scheduleTransition", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedCatalog(t);
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "TIME-1",
      variant_label: "V",
      is_default: true,
    });
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 10,
      starts_at: Date.now() - 1_000,
    });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 10,
    });

    // Future base price starts in one hour and ends an hour later.
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 20,
      starts_at: Date.now() + 3_600_000,
      ends_at: Date.now() + 7_200_000,
    });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 10,
    });

    // Activation: time passes with no writes; the scheduled transition must
    // refresh the summary.
    vi.setSystemTime(Date.now() + 3_600_000 + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 20,
    });

    // Expiration: after ends_at, the older price (10) becomes active again.
    vi.setSystemTime(Date.now() + 3_600_000 + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 10,
    });
  });

  it("prefers base over store price and stays deterministic for multiple stores", async () => {
    const t = convexTest({ schema, modules });
    const { productId, storeId } = await seedCatalog(t);
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "PREC-1",
      variant_label: "V",
      is_default: true,
    });
    const storePriceId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeId,
      sale_price: 5,
      starts_at: Date.now() - 1_000,
    });
    // single store price -> used
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 5,
    });

    // base price beats the store price
    const basePriceId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 9,
      starts_at: Date.now() - 1_000,
    });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 9,
    });

    // removing the base price falls back to the single store price
    await t.mutation(api.prices.remove, { id: basePriceId });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_price: 5,
    });

    // two distinct store prices -> ambiguous, no arbitrary winner
    const otherStoreId = await t.run(async (ctx) =>
      ctx.db.insert("stores", {
        name: "Store 2",
        status: "active",
        address: "B",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: 1,
        updated_at: 1,
      }),
    );
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: otherStoreId,
      sale_price: 6,
      starts_at: Date.now() - 1_000,
    });
    const product = await getProduct(t, productId);
    expect(product?.default_price).toBeUndefined();
    void storePriceId;
  });

  it("updates summaries when SKUs move between products", async () => {
    const t = convexTest({ schema, modules });
    const first = await seedCatalog(t);
    const second = await t.run(async (ctx) => {
      const productId = await ctx.db.insert("products", {
        primary_category_id: first.categoryId,
        name: "Second Product",
        slug: "second-product",
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
      return { productId };
    });
    const skuId = await t.mutation(api.skus.create, {
      product_id: first.productId,
      sku_code: "MOVE-1",
      variant_label: "V",
      is_default: true,
    });
    await expect(getProduct(t, first.productId)).resolves.toMatchObject({
      sku_count: 1,
      default_sku_id: skuId,
    });

    await t.mutation(api.skus.update, {
      id: skuId,
      product_id: second.productId,
    });
    const source = await getProduct(t, first.productId);
    expect(source?.sku_count).toBe(0);
    expect(source?.default_sku_id).toBeUndefined();
    await expect(getProduct(t, second.productId)).resolves.toMatchObject({
      sku_count: 1,
      default_sku_id: skuId,
    });
  });

  it("keeps the default-SKU invariant on change and deletion", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedCatalog(t);
    const firstSku = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "DEF-1",
      variant_label: "A",
      is_default: true,
    });
    const secondSku = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "DEF-2",
      variant_label: "B",
    });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_sku_id: firstSku,
    });

    await t.mutation(api.skus.update, { id: secondSku, is_default: true });
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_sku_id: secondSku,
    });

    await t.mutation(api.skus.remove, { id: secondSku });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(getProduct(t, productId)).resolves.toMatchObject({
      default_sku_id: firstSku,
      sku_count: 1,
    });
  });
});
