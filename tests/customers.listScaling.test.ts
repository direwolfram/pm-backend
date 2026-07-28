import { describe, expect, it } from "vitest";
import { listHandler } from "../convex/customers";
import { doc, FakeConvexDb } from "./fakeConvexDb";

describe("customers.list read scaling", () => {
  it("uses customer aggregates without scanning orders", async () => {
    const customers = Array.from({ length: 50 }, (_, index) =>
      doc("customers", {
        _id: `customer_${index}`,
        phone_country_code: "+63",
        phone_number: `900${index}`,
        display_name: `Customer ${index}`,
        status: index % 2 === 0 ? "active" : "blocked",
        marketing_opt_in: false,
        order_count: index,
        total_spend: index * 10,
        customerStatsVersion: 1,
        created_at: 10_000 - index,
        updated_at: 10_000 - index,
      }),
    );
    const db = new FakeConvexDb({
      customers,
      orders: Array.from({ length: 500 }, (_, index) =>
        doc("orders", {
          _id: `order_${index}`,
          order_number: `PM-${index}`,
          customer_id: `customer_${index % 50}`,
          store_id: "store",
          address_id: "addr",
          delivery_mode: "express",
          status: "confirmed",
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: 1,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: 1,
          placed_at: index,
        }),
      ),
    });

    const result = await listHandler({ db }, { status: "active", limit: 5 });

    expect(result.data).toHaveLength(5);
    expect(result.data.every((row) => row.status === "active")).toBe(true);
    expect(result.data[0]).toMatchObject({ order_count: 0, total_spend: 0 });
    expect(db.stats.collect["customers.by_status_created"]).toBe(1);
    expect(db.stats.collect.orders).toBeUndefined();
  });
});
