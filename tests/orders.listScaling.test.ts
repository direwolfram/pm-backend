import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler } from "../convex/orders";
import { doc, FakeConvexDb } from "./fakeConvexDb";

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
