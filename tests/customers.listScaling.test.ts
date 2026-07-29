import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { listHandler } from "../convex/customers";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

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
      listCounts: [
        doc("listCounts", {
          _id: "lc_active",
          scope: "customers",
          key: "status:active",
          count: 25,
        }),
      ],
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
    expect(result.total).toBe(25);
    expect(result.totalIsExact).toBe(true);
    expect(result.data.every((row) => row.status === "active")).toBe(true);
    expect(result.data[0]).toMatchObject({ order_count: 0, total_spend: 0 });
    expect(db.stats.collect["customers.by_status_created"]).toBe(1);
    expect(db.stats.collect.orders).toBeUndefined();
    // counter read is a point lookup, not a scan
    expect(db.stats.collect.customers).toBeUndefined();
  });
});

describe("customers.list cursor pagination", () => {
  it("continues across duplicate created_at values without duplicates", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let index = 0; index < 5; index += 1) {
        await ctx.db.insert("customers", {
          phone_country_code: "+63",
          phone_number: `901${index}`,
          display_name: `Customer ${index}`,
          status: "active",
          marketing_opt_in: false,
          search_text: `customer ${index}`,
          order_count: 0,
          total_spend: 0,
          customerStatsVersion: 1,
          created_at: 1_000,
          updated_at: 1_000,
        });
      }
    });

    const first = await t.query(api.customers.list, { limit: 2 });
    const second = await t.query(api.customers.list, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await t.query(api.customers.list, {
      limit: 2,
      cursor: second.nextCursor,
    });
    const ids = [...first.data, ...second.data, ...third.data].map((row) => row._id);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("paginates search results without duplicates and rejects stale cursors", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let index = 0; index < 7; index += 1) {
        await ctx.db.insert("customers", {
          phone_country_code: "+63",
          phone_number: `902${index}`,
          display_name: index < 6 ? `Maria ${index}` : `Juan ${index}`,
          status: index % 2 === 0 ? "active" : "blocked",
          marketing_opt_in: false,
          search_text: index < 6 ? `maria ${index}` : `juan ${index}`,
          order_count: 0,
          total_spend: 0,
          customerStatsVersion: 2,
          created_at: 1_000 + index,
          updated_at: 1_000 + index,
        });
      }
    });

    await t.mutation(internal.customers.backfillCustomerSearchTokens, { limit: 200 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: any = await t.query(api.customers.list, {
        search: "maria",
        limit: 2,
        cursor,
      } as any);
      seen.push(...page.data.map((row: any) => row.display_name as string));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    // defined outcome for cross-query cursor reuse
    const first = await t.query(api.customers.list, {
      search: "maria",
      limit: 1,
    });
    await expect(
      t.query(api.customers.list, {
        search: "juan",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      t.query(api.customers.list, {
        search: "maria",
        status: "active",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      t.query(api.customers.list, { limit: 1, cursor: "garbage" }),
    ).rejects.toThrow(/cursor/i);
  });

  it("supports capped offset compatibility and rejects deep offsets", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let index = 0; index < 205; index += 1) {
        await ctx.db.insert("customers", {
          phone_country_code: "+63",
          phone_number: `9${String(index).padStart(5, "0")}`,
          status: "active",
          marketing_opt_in: false,
          created_at: index,
          updated_at: index,
        });
      }
    });

    const first = await t.query(api.customers.list, { limit: 2, offset: 0 });
    expect(first.data).toHaveLength(2);
    expect(first.total).toBe(205);
    expect(first.totalIsExact).toBe(true);
    const deep = await t.query(api.customers.list, { limit: 1, offset: 200 });
    expect(deep.data).toHaveLength(1);
    await expect(
      t.query(api.customers.list, { limit: 1, offset: 201 }),
    ).rejects.toThrow(/offset pagination is only supported up to 200/);
  });

  it("finds customers by phone after create and phone update", async () => {
    const t = convexTest({ schema, modules });
    const customerId = await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9551234",
      display_name: "Searchable",
    });
    await t.mutation(internal.customers.backfillCustomerSearchTokens, { limit: 200 });

    let found = await t.query(api.customers.list, {
      search: "+639551234",
      limit: 5,
    });
    expect(found.data).toHaveLength(1);

    await t.mutation(api.customers.updatePhone, {
      id: customerId,
      phone_number: "9669876",
    });
    found = await t.query(api.customers.list, {
      search: "9669876",
      limit: 5,
    });
    expect(found.data).toHaveLength(1);
    found = await t.query(api.customers.list, {
      search: "9551234",
      limit: 5,
    });
    expect(found.data).toHaveLength(0);
  });
});
