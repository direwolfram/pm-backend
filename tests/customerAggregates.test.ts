import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

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
    await expect(t.run(async (ctx) => await ctx.db.get(customerId))).resolves.toMatchObject({
      order_count: 1,
      total_spend: 100,
      customerStatsVersion: 1,
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
});
