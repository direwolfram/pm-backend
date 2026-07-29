import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedCatalog(t: ReturnType<typeof convexTest>) {
  const categoryId = await t.run(async (ctx) =>
    ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    }),
  );
  const productId = await t.mutation(api.products.create, {
    primary_category_id: categoryId,
    name: `Invariant Product ${Math.random()}`,
    status: "active",
  });
  const skuId = await t.mutation(api.skus.create, {
    product_id: productId,
    sku_code: `INV-${Math.random()}`,
    variant_label: "V",
    is_default: true,
  });
  const storeId = await t.run(async (ctx) =>
    ctx.db.insert("stores", {
      name: "Store",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    }),
  );
  return { categoryId, productId, skuId, storeId };
}

async function seedOrderEnv(t: ReturnType<typeof convexTest>, storeId: Id<"stores">) {
  const customerId = await t.mutation(api.customers.create, {
    phone_country_code: "+63",
    phone_number: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
  });
  const addressId = await t.run(async (ctx) =>
    ctx.db.insert("addresses", {
      customer_id: customerId,
      label: "home",
      title: "H",
      full_address: "H",
      country_code: "PH",
      latitude: 0,
      longitude: 0,
      is_default: true,
      created_at: 1,
      updated_at: 1,
    }),
  );
  return { customerId, addressId, storeId };
}

describe("cascade invariant preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("store cascade keeps total_stock and pricesActive exact", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedCatalog(t);
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeId,
      sale_price: 12,
      starts_at: Date.now() - 1_000,
    });
    await t.mutation(api.inventory.upsert, {
      sku_id: skuId,
      store_id: storeId,
      quantity_available: 40,
    });
    // second store with 10 more units
    const otherStore = await t.run(async (ctx) =>
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
    await t.mutation(api.inventory.upsert, {
      sku_id: skuId,
      store_id: otherStore,
      quantity_available: 10,
    });
    let product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.total_stock).toBe(50);
    expect(product?.default_price).toBe(12);
    expect(
      await t.run(async (ctx) => ctx.db.query("pricesActive").collect()),
    ).toHaveLength(1);

    await t.mutation(api.stores.remove, { id: storeId });

    // late references while deleting
    const orderEnv = await seedOrderEnv(t, storeId);
    await expect(
      t.mutation(api.orders.create, {
        order_number: "PM-LATE-1",
        customer_id: orderEnv.customerId,
        store_id: storeId,
        address_id: orderEnv.addressId,
        delivery_mode: "express",
        subtotal_amount: 1,
        total_amount: 1,
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.inventory.upsert, {
        sku_id: skuId,
        store_id: storeId,
        quantity_available: 5,
      }),
    ).rejects.toThrow(/being deleted/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.total_stock).toBe(10);
    expect(
      await t.run(async (ctx) => ctx.db.query("pricesActive").collect()),
    ).toHaveLength(0);
    expect(
      await t.run(async (ctx) => ctx.db.query("prices").collect()),
    ).toHaveLength(0);
    product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBeUndefined();
    await expect(
      t.run(async (ctx) => await ctx.db.get(storeId)),
    ).resolves.toBeNull();

    // continuing an already-deleted root is a no-op
    const again = await t.mutation(internal.stores.continueStoreDelete, {
      id: storeId,
    });
    expect(again).toMatchObject({ done: true });
  });

  it("abortDelete unwedges a deleting root", async () => {
    const t = convexTest({ schema, modules });
    const { storeId } = await seedCatalog(t);
    await t.mutation(api.stores.remove, { id: storeId });
    await expect(
      t.run(async (ctx) => await ctx.db.get(storeId)),
    ).resolves.toMatchObject({ deleting_at: expect.any(Number) });

    const aborted = await t.mutation(internal.cascades.abortDelete, {
      table: "stores",
      id: storeId,
    });
    expect(aborted).toMatchObject({ aborted: true });
    const store = await t.run(async (ctx) => await ctx.db.get(storeId));
    expect(store?.deleting_at).toBeUndefined();
  });

  it("sku cascade removes pricesActive mirrors and reconciles the product", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedCatalog(t);
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 9,
      starts_at: Date.now() - 1_000,
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("pricesActive").collect()),
    ).toHaveLength(1);

    await t.mutation(api.skus.remove, { id: skuId });
    await expect(
      t.mutation(api.orders.createItem, {
        order_id: "missing" as never,
        product_id: productId,
        sku_id: skuId,
        product_name_snapshot: "P",
        sku_label_snapshot: "S",
        quantity: 1,
        unit_price: 1,
      }),
    ).rejects.toThrow();

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      await t.run(async (ctx) => ctx.db.query("pricesActive").collect()),
    ).toHaveLength(0);
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.sku_count).toBe(0);
    expect(product?.default_sku_id).toBeUndefined();
    expect(product?.default_price).toBeUndefined();

    const again = await t.mutation(internal.skus.continueSkuDelete, {
      id: skuId,
    });
    expect(again).toMatchObject({ done: true });
  });

  it("product cascade removes mirrors and decrements list counters", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedCatalog(t);
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 9,
      starts_at: Date.now() - 1_000,
    });
    let page = await t.query(api.products.list, { status: "active", limit: 10 });
    expect(page.total).toBe(1);

    await t.mutation(api.products.remove, { id: productId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      await t.run(async (ctx) => ctx.db.query("pricesActive").collect()),
    ).toHaveLength(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(productId)),
    ).resolves.toBeNull();
    page = await t.query(api.products.list, { status: "active", limit: 10 });
    expect(page.total).toBe(0);
    page = await t.query(api.products.list, { limit: 10 });
    expect(page.total).toBe(0);
  });

  it("rejects order items for deleting products and SKUs", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedCatalog(t);
    const orderEnv = await seedOrderEnv(t, storeId);
    const orderId = await t.mutation(api.orders.create, {
      order_number: "PM-GUARD-1",
      customer_id: orderEnv.customerId,
      store_id: storeId,
      address_id: orderEnv.addressId,
      delivery_mode: "express",
      subtotal_amount: 1,
      total_amount: 1,
    });

    await t.mutation(api.products.remove, { id: productId });
    await expect(
      t.mutation(api.orders.createItem, {
        order_id: orderId,
        product_id: productId,
        sku_id: skuId,
        product_name_snapshot: "P",
        sku_label_snapshot: "S",
        quantity: 1,
        unit_price: 1,
      }),
    ).rejects.toThrow(/being deleted/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // sku guard: create a fresh product/sku then delete just the sku
    const { productId: p2, skuId: s2 } = await seedCatalog(t);
    void p2;
    await t.mutation(api.skus.remove, { id: s2 });
    await expect(
      t.mutation(api.orders.createItem, {
        order_id: orderId,
        product_id: p2,
        sku_id: s2,
        product_name_snapshot: "P",
        sku_label_snapshot: "S",
        quantity: 1,
        unit_price: 1,
      }),
    ).rejects.toThrow(/being deleted/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});
