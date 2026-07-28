import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { orderCountsForCustomerStats } from "../convex/lib/customerAggregates";
import type { OrderDoc } from "../convex/model";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedEnv(t: ReturnType<typeof convexTest>, confirmedOrders: number) {
  return await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", {
      phone_country_code: "+63",
      phone_number: "9000000001",
      display_name: "Race Customer",
      status: "active",
      marketing_opt_in: false,
      search_text: "race customer",
      order_count: 0,
      total_spend: 0,
      customerStatsVersion: 1,
      statsGeneration: 0,
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
    const orderIds: Id<"orders">[] = [];
    for (let index = 0; index < confirmedOrders; index += 1) {
      orderIds.push(
        await ctx.db.insert("orders", {
          order_number: `PM-RACE-${index}`,
          customer_id: customerId,
          store_id: storeId,
          address_id: addressId,
          delivery_mode: "express",
          status: "confirmed",
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: 2,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: 2,
          item_count: 1,
          order_search_text: "race",
          orderSummaryVersion: 2,
          placed_at: index + 1,
        }),
      );
    }
    return { customerId, storeId, addressId, orderIds };
  });
}

async function referenceTotals(
  t: ReturnType<typeof convexTest>,
  customerId: Id<"customers">,
) {
  return await t.run(async (ctx) => {
    const orders = (await ctx.db
      .query("orders")
      .withIndex("by_customer", (q) => q.eq("customer_id", customerId))
      .collect()) as OrderDoc[];
    return orders.reduce(
      (acc, order) => {
        const stats = orderCountsForCustomerStats(order);
        acc.order_count += stats.order_count;
        acc.total_spend += stats.total_spend;
        return acc;
      },
      { order_count: 0, total_spend: 0 },
    );
  });
}

describe("customer aggregate reconciliation concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never commits a stale snapshot when orders change between chunks", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t, 250);

    // Start reconciliation (chunk size 100 => 3 chunks) but do not drain.
    await t.mutation(internal.customers.backfillCustomerOrderStats, {
      limit: 100,
    });

    // Public reads keep the last authoritative aggregate mid-reconciliation.
    const midReads: Array<{ order_count?: number; total_spend?: number }> = [];

    // Chunk 1.
    let step = await t.mutation(
      internal.customers.continueCustomerOrderStatsReconcile,
      { customer_id: env.customerId },
    );
    expect(step.done).toBe(false);

    // Interleave every order lifecycle transition between chunks.
    await t.mutation(api.orders.updateAmounts, {
      id: env.orderIds[0],
      total_amount: 10,
    });
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[1],
      status: "cancelled",
    });
    const newOrderId = await t.mutation(api.orders.create, {
      order_number: "PM-RACE-NEW",
      customer_id: env.customerId,
      store_id: env.storeId,
      address_id: env.addressId,
      delivery_mode: "express",
      status: "confirmed",
      payment_status: "paid",
      subtotal_amount: 7,
      total_amount: 7,
    });
    const otherCustomerId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9000000002",
      display_name: "Other",
    });
    await t.mutation(api.orders.reassignCustomer, {
      id: env.orderIds[2],
      customer_id: otherCustomerId,
    });
    await t.mutation(api.orders.removeItem, {
      id: "nonexistent" as never,
    }).catch(() => undefined);
    await t.mutation(api.orders.remove, { id: env.orderIds[3] });
    // deliver + refund
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[4],
      status: "picking",
    });
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[4],
      status: "packed",
    });
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[4],
      status: "out_for_delivery",
    });
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[4],
      status: "delivered",
    });
    await t.mutation(api.orders.updateStatus, {
      id: env.orderIds[4],
      status: "refunded",
    });

    // Authoritative aggregates must reflect live deltas even mid-scan:
    // +8 (amounts) -2 (cancel) +7 (create) -2 (reassign) -2 (remove) -2
    // (refund) = +7 spend, and every delta bumped the generation.
    midReads.push(
      (await t.run(async (ctx) => await ctx.db.get(env.customerId)))!,
    );
    expect(midReads[0].total_spend).toBe(7);
    expect(
      (midReads[0] as { statsGeneration?: number }).statsGeneration,
    ).toBeGreaterThan(0);

    // Step chunks until done; the generation check forces restarts instead
    // of committing a stale snapshot.
    let restarts = 0;
    let guard = 0;
    while (!step.done) {
      guard += 1;
      expect(guard).toBeLessThan(50);
      step = await t.mutation(
        internal.customers.continueCustomerOrderStatsReconcile,
        { customer_id: env.customerId },
      );
      if ("restarted" in step && step.restarted) restarts += 1;
      if (guard === 2) {
        // Another mutation mid-restart: confirm pending order then delete it.
        await t.mutation(api.orders.updateAmounts, {
          id: newOrderId,
          total_amount: 9,
        });
      }
    }
    expect(restarts).toBeGreaterThan(0);

    // Drain any scheduled duplicate continuations — must be harmless.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const customer = await t.run(
      async (ctx) => await ctx.db.get(env.customerId),
    );
    const reference = await referenceTotals(t, env.customerId);
    expect(customer?.order_count).toBe(reference.order_count);
    expect(customer?.total_spend).toBe(reference.total_spend);
    expect(customer?.reconcile_cursor).toBeUndefined();
    expect(customer?.reconcile_totals).toBeUndefined();
    expect(customer?.reconcile_generation).toBeUndefined();

    const other = await t.run(
      async (ctx) => await ctx.db.get(otherCustomerId),
    );
    expect(other?.order_count).toBe(1);
    expect(other?.total_spend).toBe(2);
  });

  it("reconciles customers with more orders than one batch and stays idempotent", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedEnv(t, 250);

    await t.mutation(internal.customers.backfillCustomerOrderStats, {
      limit: 100,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // duplicate continuation after completion is a no-op
    const dup = await t.mutation(
      internal.customers.continueCustomerOrderStatsReconcile,
      { customer_id: env.customerId },
    );
    expect(dup.done).toBe(true);

    const customer = await t.run(
      async (ctx) => await ctx.db.get(env.customerId),
    );
    expect(customer?.order_count).toBe(250);
    expect(customer?.total_spend).toBe(500);
    expect(customer?.customerStatsVersion).toBe(2);
  });
});
