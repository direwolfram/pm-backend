import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler } from "../convex/orders";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

function order(id: string, storeId: string, customerId: string, placedAt: number) {
  return doc("orders", {
    _id: id,
    order_number: `PM-${id}`,
    customer_id: customerId,
    store_id: storeId,
    address_id: "addr",
    delivery_mode: "express",
    status: id.endsWith("0") ? "cancelled" : "confirmed",
    payment_status: "paid",
    currency: "PHP",
    subtotal_amount: 100,
    discount_amount: 0,
    delivery_fee_amount: 0,
    total_amount: 100,
    item_count: 2,
    placed_at: placedAt,
  });
}

describe("orders.list read scaling", () => {
  it("uses order indexes and enriches only the returned page", async () => {
    const target = Array.from({ length: 20 }, (_, index) =>
      order(`target_${index}`, "store_a", `customer_${index}`, 10_000 - index),
    );
    const unrelated = Array.from({ length: 300 }, (_, index) =>
      order(`old_${index}`, "store_b", `other_${index}`, index),
    );
    const db = new FakeConvexDb({
      orders: [...target, ...unrelated],
      customers: target.map((row) =>
        doc("customers", {
          _id: row.customer_id as string,
          phone_country_code: "+63",
          phone_number: String(row.customer_id),
          display_name: `Customer ${row.customer_id}`,
          status: "active",
          marketing_opt_in: false,
          created_at: 1,
          updated_at: 1,
        }),
      ),
      stores: [
        doc("stores", {
          _id: "store_a",
          name: "Store A",
          status: "active",
          address: "A",
          latitude: 0,
          longitude: 0,
          timezone: "Asia/Manila",
          created_at: 1,
          updated_at: 1,
        }),
      ],
      order_items: Array.from({ length: 500 }, (_, index) =>
        doc("order_items", {
          _id: `item_${index}`,
          order_id: `old_${index}`,
          product_id: "product",
          sku_id: "sku",
          product_name_snapshot: "P",
          sku_label_snapshot: "S",
          quantity: 1,
          unit_price: 1,
          line_total: 1,
        }),
      ),
    });

    const result = await listHandler(
      { db },
      { store_id: "store_a" as Id<"stores">, limit: 5 },
    );

    expect(result.data).toHaveLength(5);
    expect(result.data.every((row) => row.store_id === "store_a")).toBe(true);
    expect(db.stats.collect["orders.by_store_placed"]).toBe(1);
    expect(db.stats.collect.orders).toBeUndefined();
    expect(db.stats.collect.customers).toBeUndefined();
    expect(db.stats.collect.stores).toBeUndefined();
    expect(db.stats.collect.order_items).toBeUndefined();
    expect(db.stats.get.customers).toBe(5);
    expect(db.stats.get.stores).toBe(1);
  });
});

describe("orders.list cursor pagination", () => {
  it("continues without skipping or duplicating orders that share placed_at", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "900",
        display_name: "Cursor Customer",
        status: "active",
        marketing_opt_in: false,
        search_text: "cursor customer +63 900",
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
      for (let index = 0; index < 5; index += 1) {
        await ctx.db.insert("orders", {
          order_number: `PM-CURSOR-${index}`,
          customer_id: customerId,
          store_id: storeId,
          address_id: addressId,
          delivery_mode: "express",
          status: "confirmed",
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: 10,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: 10,
          item_count: 1,
          order_search_text: `pm-cursor-${index} cursor customer`,
          orderSummaryVersion: 2,
          placed_at: 1_000,
        });
      }
    });

    const first = await t.query(api.orders.list, { limit: 2 });
    const second = await t.query(api.orders.list, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await t.query(api.orders.list, {
      limit: 2,
      cursor: second.nextCursor,
    });
    const seen = [...first.data, ...second.data, ...third.data].map(
      (row) => row.order_number,
    );

    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    expect(third.hasMore).toBe(false);
  });
});
