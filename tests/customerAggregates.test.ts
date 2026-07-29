import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

describe("customer order aggregates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backfills and updates totals when orders are cancelled", async () => {
    const t = convexTest({ schema, modules });
    const { customerId, orderId } = await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "9000000000",
        display_name: "Customer",
        status: "active",
        marketing_opt_in: false,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const storeId = await ctx.db.insert("stores", {
        name: "Store",
        status: "active",
        address: "A",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: Date.now(),
        updated_at: Date.now(),
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
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const orderId = await ctx.db.insert("orders", {
        order_number: "PM-AGG-1",
        customer_id: customerId,
        store_id: storeId,
        address_id: addressId,
        delivery_mode: "express",
        status: "confirmed",
        payment_status: "paid",
        currency: "PHP",
        subtotal_amount: 100,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: 100,
        placed_at: Date.now(),
      });
      return { customerId, orderId };
    });

    await expect(
      t.mutation(internal.customers.backfillCustomerOrderStats, { limit: 1 }),
    ).resolves.toMatchObject({ processed: 1, patched: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(t.run(async (ctx) => await ctx.db.get(customerId))).resolves.toMatchObject({
      order_count: 1,
      total_spend: 100,
      customerStatsVersion: 2,
    });

    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "cancelled",
    });
    await expect(t.run(async (ctx) => await ctx.db.get(customerId))).resolves.toMatchObject({
      order_count: 0,
      total_spend: 0,
    });
  });

  async function seedCustomerWithOrder(
    t: ReturnType<typeof convexTest>,
    opts: { status: string; total: number; phone?: string },
  ) {
    return await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: opts.phone ?? "9000000001",
        display_name: "Stats Customer",
        status: "active",
        marketing_opt_in: false,
        search_text: "stats customer",
        order_count: 0,
        total_spend: 0,
        customerStatsVersion: 2,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const storeId = await ctx.db.insert("stores", {
        name: "Store",
        status: "active",
        address: "A",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: Date.now(),
        updated_at: Date.now(),
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
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const orderId = await ctx.db.insert("orders", {
        order_number: "PM-STATS-0",
        customer_id: customerId,
        store_id: storeId,
        address_id: addressId,
        delivery_mode: "express",
        status: opts.status,
        payment_status: "paid",
        currency: "PHP",
        subtotal_amount: opts.total,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: opts.total,
        item_count: 1,
        order_search_text: "stats",
        orderSummaryVersion: 2,
        placed_at: Date.now(),
      });
      return { customerId, storeId, addressId, orderId };
    });
  }

  async function insertOrders(
    t: ReturnType<typeof convexTest>,
    env: { customerId: Id<"customers">; storeId: Id<"stores">; addressId: Id<"addresses"> },
    count: number,
    status: string,
    total: number,
  ) {
    await t.run(async (ctx) => {
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert("orders", {
          order_number: `PM-STATS-X-${index}-${Math.random()}`,
          customer_id: env.customerId,
          store_id: env.storeId,
          address_id: env.addressId,
          delivery_mode: "express",
          status,
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: total,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: total,
          item_count: 1,
          order_search_text: "stats",
          orderSummaryVersion: 2,
          placed_at: Date.now(),
        });
      }
    });
  }

  it("excludes pending_payment orders from aggregates (v2 semantics)", async () => {
    const t = convexTest({ schema, modules });
    const { customerId, orderId } = await seedCustomerWithOrder(t, {
      status: "pending_payment",
      total: 50,
    });

    await t.mutation(api.orders.updateAmounts, {
      id: orderId,
      total_amount: 50,
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(customerId)),
    ).resolves.toMatchObject({ order_count: 0, total_spend: 0 });

    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "confirmed",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(customerId)),
    ).resolves.toMatchObject({ order_count: 1, total_spend: 50 });
  });

  it("moves aggregates on reassignment and removes them on refund", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedCustomerWithOrder(t, {
      status: "pending_payment",
      total: 0,
    });
    const orderId = await t.mutation(api.orders.create, {
      order_number: "PM-MOVE-1",
      customer_id: env.customerId,
      store_id: env.storeId,
      address_id: env.addressId,
      delivery_mode: "express",
      status: "confirmed",
      payment_status: "paid",
      subtotal_amount: 80,
      total_amount: 80,
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(env.customerId)),
    ).resolves.toMatchObject({ order_count: 1, total_spend: 80 });
    const otherId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9000000099",
      display_name: "Second",
    });

    await t.mutation(api.orders.reassignCustomer, {
      id: orderId,
      customer_id: otherId,
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(env.customerId)),
    ).resolves.toMatchObject({ order_count: 0, total_spend: 0 });
    await expect(
      t.run(async (ctx) => await ctx.db.get(otherId)),
    ).resolves.toMatchObject({ order_count: 1, total_spend: 80 });

    // deliver then refund
    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "picking",
    });
    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "packed",
    });
    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "out_for_delivery",
    });
    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "delivered",
    });
    await t.mutation(api.orders.updateStatus, {
      id: orderId,
      status: "refunded",
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(otherId)),
    ).resolves.toMatchObject({ order_count: 0, total_spend: 0 });
  });

  it("reconciles corrupted totals and is safe under duplicate continuations", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedCustomerWithOrder(t, {
      status: "confirmed",
      total: 10,
    });
    await insertOrders(t, env, 149, "confirmed", 1);
    await t.run(async (ctx) => {
      // deliberately corrupted totals
      await ctx.db.patch(env.customerId, {
        order_count: 9999,
        total_spend: 9999,
        customerStatsVersion: 1,
      });
    });

    await t.mutation(internal.customers.backfillCustomerOrderStats, {
      limit: 100,
    });
    // Drain continuations (multi-page reconciliation over 150 orders).
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Duplicate continuation execution must be harmless: it recomputes the
    // same totals from scratch.
    await t.mutation(internal.customers.continueCustomerOrderStatsReconcile, {
      customer_id: env.customerId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await expect(
      t.run(async (ctx) => await ctx.db.get(env.customerId)),
    ).resolves.toMatchObject({
      order_count: 150,
      total_spend: 10 + 149,
      customerStatsVersion: 2,
    });
    const reconciled = await t.run(
      async (ctx) => await ctx.db.get(env.customerId),
    );
    expect(reconciled?.reconcile_cursor).toBeUndefined();
    expect(reconciled?.reconcile_totals).toBeUndefined();
  });

  it("maintains aggregates on order creation and deletion through the public API", async () => {
    const t = convexTest({ schema, modules });
    const { customerId, storeId, addressId } = await seedCustomerWithOrder(t, {
      status: "confirmed",
      total: 5,
    });

    const orderId = await t.mutation(api.orders.create, {
      order_number: "PM-NEW-1",
      customer_id: customerId,
      store_id: storeId,
      address_id: addressId,
      delivery_mode: "express",
      status: "confirmed",
      payment_status: "paid",
      subtotal_amount: 30,
      total_amount: 30,
    });
    await expect(
      t.run(async (ctx) => await ctx.db.get(customerId)),
    ).resolves.toMatchObject({ order_count: 1, total_spend: 30 });

    await t.mutation(api.orders.remove, { id: orderId });
    await expect(
      t.run(async (ctx) => await ctx.db.get(customerId)),
    ).resolves.toMatchObject({ order_count: 0, total_spend: 0 });
  });
});
