import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedOrder(
  t: ReturnType<typeof convexTest>,
  opts?: {
    itemCount?: number;
    summaryVersion?: number;
    searchText?: string;
    status?: string;
    total?: number;
  },
) {
  return await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", {
      phone_country_code: "+63",
      phone_number: "911",
      display_name: "Summary Customer",
      status: "active",
      marketing_opt_in: false,
      search_text: "summary customer +63 911 +63911",
      order_count: 0,
      total_spend: 0,
      customerStatsVersion: 2,
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
    const addressId = await ctx.db.insert("addresses", {
      customer_id: customerId,
      label: "home",
      title: "Home",
      full_address: "Home",
      country_code: "PH",
      latitude: 0,
      longitude: 0,
      is_default: true,
      created_at: 1,
      updated_at: 1,
    });
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: "cat",
      sort_order: 1,
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: "Product",
      slug: "product",
      status: "active",
      rating_average: 0,
      rating_count: 0,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    const skuId = await ctx.db.insert("skus", {
      product_id: productId,
      sku_code: "SKU-1",
      variant_label: "V",
      sort_order: 0,
      is_default: true,
      is_active: true,
    });
    const orderId = await ctx.db.insert("orders", {
      order_number: "PM-SUM-1",
      customer_id: customerId,
      store_id: storeId,
      address_id: addressId,
      delivery_mode: "express",
      status: opts?.status ?? "confirmed",
      payment_status: "paid",
      currency: "PHP",
      subtotal_amount: opts?.total ?? 100,
      discount_amount: 0,
      delivery_fee_amount: 0,
      total_amount: opts?.total ?? 100,
      ...(opts?.itemCount === undefined ? {} : { item_count: opts.itemCount }),
      order_search_text:
        opts?.searchText ?? "pm-sum-1 summary customer +63 911 +63911",
      ...(opts?.summaryVersion === undefined
        ? {}
        : { orderSummaryVersion: opts.summaryVersion }),
      placed_at: 1_000,
    });
    return { customerId, storeId, addressId, productId, skuId, orderId };
  });
}

async function getOrder(t: ReturnType<typeof convexTest>, orderId: Id<"orders">) {
  return await t.run(async (ctx) => await ctx.db.get(orderId));
}

describe("order item_count maintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not double-count when the stored count is missing", async () => {
    const t = convexTest({ schema, modules });
    const { orderId, productId, skuId } = await seedOrder(t);

    const itemId = await t.mutation(api.orders.createItem, {
      order_id: orderId,
      product_id: productId,
      sku_id: skuId,
      product_name_snapshot: "P",
      sku_label_snapshot: "S",
      quantity: 3,
      unit_price: 10,
    });
    await expect(getOrder(t, orderId)).resolves.toMatchObject({
      item_count: 3,
      orderSummaryVersion: 2,
    });

    // Second insert on an order whose stored count exists adds only its own
    // quantity.
    await t.mutation(api.orders.createItem, {
      order_id: orderId,
      product_id: productId,
      sku_id: skuId,
      product_name_snapshot: "P",
      sku_label_snapshot: "S",
      quantity: 2,
      unit_price: 10,
    });
    await expect(getOrder(t, orderId)).resolves.toMatchObject({
      item_count: 5,
    });
    expect(itemId).toBeDefined();
  });

  it("validates quantity and prices on createItem and updateItem", async () => {
    const t = convexTest({ schema, modules });
    const { orderId, productId, skuId } = await seedOrder(t, {
      itemCount: 1,
      summaryVersion: 2,
    });
    await expect(
      t.mutation(api.orders.createItem, {
        order_id: orderId,
        product_id: productId,
        sku_id: skuId,
        product_name_snapshot: "P",
        sku_label_snapshot: "S",
        quantity: 0,
        unit_price: 10,
      }),
    ).rejects.toThrow(/quantity/);
    await expect(
      t.mutation(api.orders.createItem, {
        order_id: orderId,
        product_id: productId,
        sku_id: skuId,
        product_name_snapshot: "P",
        sku_label_snapshot: "S",
        quantity: 1,
        unit_price: -5,
      }),
    ).rejects.toThrow(/unit_price/);
  });

  it("tracks update, move, and removal across orders", async () => {
    const t = convexTest({ schema, modules });
    const first = await seedOrder(t, { itemCount: 0, summaryVersion: 2 });
    const second = await seedOrder(t, { itemCount: 0, summaryVersion: 2 });

    const itemId = await t.mutation(api.orders.createItem, {
      order_id: first.orderId,
      product_id: first.productId,
      sku_id: first.skuId,
      product_name_snapshot: "P",
      sku_label_snapshot: "S",
      quantity: 4,
      unit_price: 10,
    });
    await t.mutation(api.orders.updateItem, { id: itemId, quantity: 6 });
    await expect(getOrder(t, first.orderId)).resolves.toMatchObject({
      item_count: 6,
    });

    await t.mutation(api.orders.updateItem, {
      id: itemId,
      order_id: second.orderId,
    });
    await expect(getOrder(t, first.orderId)).resolves.toMatchObject({
      item_count: 0,
    });
    await expect(getOrder(t, second.orderId)).resolves.toMatchObject({
      item_count: 6,
    });

    await t.mutation(api.orders.removeItem, { id: itemId });
    await expect(getOrder(t, second.orderId)).resolves.toMatchObject({
      item_count: 0,
    });
  });

  it("rejects moving an item to a missing order", async () => {
    const t = convexTest({ schema, modules });
    const { orderId, productId, skuId } = await seedOrder(t, {
      itemCount: 0,
      summaryVersion: 2,
    });
    const itemId = await t.mutation(api.orders.createItem, {
      order_id: orderId,
      product_id: productId,
      sku_id: skuId,
      product_name_snapshot: "P",
      sku_label_snapshot: "S",
      quantity: 1,
      unit_price: 10,
    });
    const missing = await t.run(async (ctx) => {
      const ghost = await ctx.db.insert("orders", {
        order_number: "PM-GHOST",
        customer_id: (
          await ctx.db.query("customers").first()
        )!._id,
        store_id: (await ctx.db.query("stores").first())!._id,
        address_id: (await ctx.db.query("addresses").first())!._id,
        delivery_mode: "express",
        status: "confirmed",
        payment_status: "paid",
        currency: "PHP",
        subtotal_amount: 1,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: 1,
        placed_at: 1,
      });
      await ctx.db.delete(ghost);
      return ghost;
    });
    await expect(
      t.mutation(api.orders.updateItem, { id: itemId, order_id: missing }),
    ).rejects.toThrow(/Order not found/);
    await expect(getOrder(t, orderId)).resolves.toMatchObject({
      item_count: 1,
    });
  });
});

describe("order summary backfill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("repairs missing and stale versions, wrong counts, and wrong search text", async () => {
    const t = convexTest({ schema, modules });
    const missing = await seedOrder(t, { itemCount: 99, searchText: "wrong" });
    const stale = await seedOrder(t, {
      itemCount: 99,
      summaryVersion: 1,
      searchText: "wrong",
    });
    for (const env of [missing, stale]) {
      await t.run(async (ctx) => {
        await ctx.db.insert("order_items", {
          order_id: env.orderId,
          product_id: env.productId,
          sku_id: env.skuId,
          product_name_snapshot: "P",
          sku_label_snapshot: "S",
          quantity: 7,
          unit_price: 1,
          line_total: 7,
        });
      });
    }

    const first = await t.mutation(internal.orders.backfillOrderListSummaries, {
      limit: 100,
    });
    expect(first.processed).toBe(2);
    expect(first.patched).toBe(2);

    for (const env of [missing, stale]) {
      await expect(getOrder(t, env.orderId)).resolves.toMatchObject({
        item_count: 7,
        orderSummaryVersion: 2,
      });
      const order = await getOrder(t, env.orderId);
      expect(order?.order_search_text).toContain("summary customer");
    }

    // Duplicate execution is a no-op.
    const second = await t.mutation(internal.orders.backfillOrderListSummaries, {
      limit: 100,
    });
    expect(second.processed).toBe(0);
    expect(second.patched).toBe(0);
  });
});

describe("order search text maintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes when display name, email, or phone fields change", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedOrder(t);

    await t.mutation(api.customers.updateProfile, {
      id: env.customerId,
      display_name: "Renamed Customer",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let order = await getOrder(t, env.orderId);
    expect(order?.order_search_text).toContain("renamed customer");

    await t.mutation(api.customers.updatePhone, {
      id: env.customerId,
      phone_number: "922",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    order = await getOrder(t, env.orderId);
    expect(order?.order_search_text).toContain("+63922");

    await t.mutation(api.customers.updatePhone, {
      id: env.customerId,
      phone_country_code: "+1",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    order = await getOrder(t, env.orderId);
    expect(order?.order_search_text).toContain("+1922");

    const customer = await t.run(
      async (ctx) => await ctx.db.get(env.customerId),
    );
    expect(customer?.search_text).toContain("+1922");
  });

  it("updates search text on customer reassignment", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedOrder(t);
    const otherCustomerId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "933",
      display_name: "Other Customer",
    });

    await t.mutation(api.orders.reassignCustomer, {
      id: env.orderId,
      customer_id: otherCustomerId,
    });
    const order = await getOrder(t, env.orderId);
    expect(order?.order_search_text).toContain("other customer");
  });
});

describe("order deletion", () => {
  it("restricts deletion while items exist and deletes cleanly after", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedOrder(t, { itemCount: 1, summaryVersion: 2 });
    const itemId = await t.mutation(api.orders.createItem, {
      order_id: env.orderId,
      product_id: env.productId,
      sku_id: env.skuId,
      product_name_snapshot: "P",
      sku_label_snapshot: "S",
      quantity: 1,
      unit_price: 10,
    });

    await expect(
      t.mutation(api.orders.remove, { id: env.orderId }),
    ).rejects.toThrow(/Delete order items/);

    await t.mutation(api.orders.removeItem, { id: itemId });
    await t.mutation(api.orders.remove, { id: env.orderId });
    await expect(getOrder(t, env.orderId)).resolves.toBeNull();
  });
});
