import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

function testConvex() {
  return convexTest({ schema, modules });
}

async function insertCategory(t: ReturnType<typeof testConvex>, name = "Pantry") {
  return await t.run(async (ctx) =>
    await ctx.db.insert("categories", {
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      sort_order: 0,
      is_active: true,
    }),
  );
}

async function insertProduct(t: ReturnType<typeof testConvex>) {
  const categoryId = await insertCategory(t);
  return await t.run(async (ctx) =>
    await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: "Fixture Product",
      slug: "fixture-product",
      status: "active",
      rating_average: 0,
      rating_count: 0,
      attributes: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
  );
}

async function insertStore(t: ReturnType<typeof testConvex>) {
  return await t.run(async (ctx) =>
    await ctx.db.insert("stores", {
      name: "Store A",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
  );
}

async function insertCustomer(t: ReturnType<typeof testConvex>) {
  return await t.run(async (ctx) =>
    await ctx.db.insert("customers", {
      phone_country_code: "+63",
      phone_number: "9000000000",
      display_name: "Customer",
      status: "active",
      marketing_opt_in: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    }),
  );
}

describe("domain regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("documents the current anonymous admin mutation boundary", async () => {
    const t = testConvex();

    const id = await t.mutation(api.categories.create, {
      name: "Anonymous Created",
      is_active: true,
    });

    await expect(
      t.run(async (ctx) => await ctx.db.get(id)),
    ).resolves.toMatchObject({ name: "Anonymous Created" });
  });

  it("prevents category parent cycles", async () => {
    const t = testConvex();
    const parentId = await t.mutation(api.categories.create, {
      name: "Parent",
      is_active: true,
    });
    const childId = await t.mutation(api.categories.create, {
      name: "Child",
      parent_id: parentId,
      is_active: true,
    });

    await expect(
      t.mutation(api.categories.update, {
        id: parentId,
        parent_id: childId,
      }),
    ).rejects.toThrow("cycle");
  });

  it("keeps exactly one default SKU per product", async () => {
    const t = testConvex();
    const productId = await insertProduct(t);
    const first = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "SKU-A",
      variant_label: "A",
      is_default: true,
    });
    const second = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "SKU-B",
      variant_label: "B",
      is_default: true,
    });

    await expect(
      t.run(async (ctx) => await ctx.db.get(first)),
    ).resolves.toMatchObject({ is_default: false });
    await expect(
      t.run(async (ctx) => await ctx.db.get(second)),
    ).resolves.toMatchObject({ is_default: true });

    await t.mutation(api.skus.remove, { id: second });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(
      t.run(async (ctx) => await ctx.db.get(first)),
    ).resolves.toMatchObject({ is_default: true });
  });

  it("validates pricing and promotion windows", async () => {
    const t = testConvex();
    const productId = await insertProduct(t);
    const skuId = await t.mutation(api.skus.create, {
      product_id: productId,
      sku_code: "SKU-WINDOW",
      variant_label: "Window",
      is_default: true,
    });

    await expect(
      t.mutation(api.prices.upsert, {
        sku_id: skuId,
        sale_price: 10,
        starts_at: Date.now(),
        ends_at: Date.now() - 1,
      }),
    ).rejects.toThrow("ends_at");
    await expect(
      t.mutation(api.promotions.create, {
        kind: "coupon",
        title: "Bad Window",
        starts_at: Date.now(),
        ends_at: Date.now(),
      }),
    ).rejects.toThrow("ends_at");

    await t.mutation(api.promotions.create, {
      kind: "coupon",
      title: "Running",
      starts_at: Date.now() - 1,
      ends_at: Date.now() + 10_000,
      is_active: true,
    });
    await t.mutation(api.promotions.create, {
      kind: "coupon",
      title: "Future",
      starts_at: Date.now() + 10_000,
      ends_at: Date.now() + 20_000,
      is_active: true,
    });

    const active = await t.query(api.promotions.list, { activeOnly: true });
    expect(active.data.map((promo) => promo.title)).toEqual(["Running"]);
  });

  it("enforces order transitions and mirrors payment status", async () => {
    const t = testConvex();
    const storeId = await insertStore(t);
    const customerId = await insertCustomer(t);
    const addressId = await t.run(async (ctx) =>
      await ctx.db.insert("addresses", {
        customer_id: customerId,
        label: "home",
        title: "Home",
        full_address: "Home",
        country_code: "PH",
        latitude: 0,
        longitude: 0,
        is_default: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );
    const orderId = await t.run(async (ctx) =>
      await ctx.db.insert("orders", {
        order_number: "PM-TEST-1",
        customer_id: customerId,
        store_id: storeId,
        address_id: addressId,
        delivery_mode: "express",
        status: "pending_payment",
        payment_status: "pending",
        currency: "PHP",
        subtotal_amount: 10,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: 10,
        placed_at: Date.now(),
      }),
    );
    const paymentId = await t.run(async (ctx) =>
      await ctx.db.insert("payments", {
        order_id: orderId,
        provider: "test",
        status: "pending",
        amount: 10,
        currency: "PHP",
        created_at: Date.now(),
        updated_at: Date.now(),
      }),
    );

    await expect(
      t.mutation(api.orders.updateStatus, {
        id: orderId,
        status: "delivered",
      }),
    ).rejects.toThrow("Cannot move order");

    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "confirmed",
    });
    await t.mutation(api.orders.updatePaymentStatus, {
      id: orderId,
      payment_status: "paid",
    });

    await expect(
      t.run(async (ctx) => await ctx.db.get(orderId)),
    ).resolves.toMatchObject({
      status: "confirmed",
      payment_status: "paid",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(paymentId)),
    ).resolves.toMatchObject({ status: "paid", paid_at: Date.now() });
  });

  it("filters home sections by visibility window and active state", async () => {
    const t = testConvex();
    await t.run(async (ctx) => {
      for (const [key, isActive, startsAt, endsAt] of [
        ["visible", true, Date.now() - 1, Date.now() + 10_000],
        ["inactive", false, Date.now() - 1, Date.now() + 10_000],
        ["future", true, Date.now() + 10_000, Date.now() + 20_000],
      ] as const) {
        await ctx.db.insert("home_sections", {
          key,
          kind: "custom_cta",
          title: key,
          tab: "All",
          sortOrder: key === "visible" ? 1 : 2,
          isActive,
          allowEmpty: true,
          startsAt,
          endsAt,
          timezone: "Asia/Manila",
        });
      }
    });

    const sections = await t.query(api.homeSections.list, { tab: "All" });

    expect(sections.data.map((section) => section.key)).toEqual(["visible"]);
  });
});
