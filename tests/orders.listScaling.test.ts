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
    order_search_text: `pm-${id}`.toLowerCase(),
    orderSummaryVersion: 2,
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
      listCounts: [
        doc("listCounts", {
          _id: "lc_store_a",
          scope: "orders",
          key: "store:store_a",
          count: 20,
        }),
      ],
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
    expect(result.total).toBe(20);
    expect(result.totalIsExact).toBe(true);
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

  async function seedEnv(t: ReturnType<typeof convexTest>, orderCount: number, opts?: {
    searchText?: (index: number) => string;
    status?: (index: number) => string;
    storeId?: (index: number) => "a" | "b";
    placedAt?: (index: number) => number;
  }) {
    return await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "900",
        display_name: "Paged Customer",
        status: "active",
        marketing_opt_in: false,
        created_at: 1,
        updated_at: 1,
      });
      const storeA = await ctx.db.insert("stores", {
        name: "Store A",
        status: "active",
        address: "A",
        latitude: 0,
        longitude: 0,
        timezone: "Asia/Manila",
        created_at: 1,
        updated_at: 1,
      });
      const storeB = await ctx.db.insert("stores", {
        name: "Store B",
        status: "active",
        address: "B",
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
      const ids = [];
      for (let index = 0; index < orderCount; index += 1) {
        const status = opts?.status?.(index) ?? "confirmed";
        const id = await ctx.db.insert("orders", {
          order_number: `PM-PAGE-${index}`,
          customer_id: customerId,
          store_id: opts?.storeId?.(index) === "b" ? storeB : storeA,
          address_id: addressId,
          delivery_mode: "express",
          status,
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: 10,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: 10,
          item_count: 1,
          order_search_text:
            opts?.searchText?.(index) ?? `pm-page-${index} paged customer`,
          orderSummaryVersion: 2,
          placed_at: opts?.placedAt?.(index) ?? 5_000 - index,
        });
        ids.push(id);
      }
      return { customerId, storeA, storeB, addressId, ids };
    });
  }

  async function collectAll(
    t: ReturnType<typeof convexTest>,
    args: Record<string, unknown>,
    limit = 2,
  ) {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: any = await t.query(api.orders.list, {
        ...args,
        limit,
        cursor,
      } as any);
      seen.push(...page.data.map((row: any) => row.order_number as string));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null && pages < 20);
    return { seen, pages };
  }

  it("paginates search results across three pages without duplicates or omissions", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 7, {
      searchText: (index) =>
        index < 6 ? `needle order ${index}` : `other order ${index}`,
    });

    const { seen, pages } = await collectAll(t, { search: "needle" });

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("paginates combined status and store filters", async () => {
    const t = convexTest({ schema, modules });
    const { storeA } = await seedEnv(t, 9, {
      status: (index) => (index % 3 === 0 ? "cancelled" : "confirmed"),
      storeId: (index) => (index % 2 === 0 ? "a" : "b"),
    });

    const { seen } = await collectAll(t, {
      status: "confirmed",
      store_id: storeA,
    });

    expect(seen.length).toBeGreaterThan(0);
    const all = await t.query(api.orders.list, { limit: 200 });
    const expected = all.data.filter(
      (row: any) => row.status === "confirmed" && row.store_id === storeA,
    );
    expect(seen.sort()).toEqual(
      expected.map((row: any) => row.order_number).sort(),
    );
  });

  it("paginates combined filters through the search index", async () => {
    const t = convexTest({ schema, modules });
    const { storeA } = await seedEnv(t, 8, {
      searchText: (index) => `needle order ${index}`,
      status: (index) => (index % 2 === 0 ? "confirmed" : "picking"),
      storeId: (index) => (index % 2 === 0 ? "a" : "b"),
    });

    const { seen, pages } = await collectAll(t, {
      search: "needle",
      status: "confirmed",
      store_id: storeA,
    });

    expect(pages).toBeGreaterThanOrEqual(2);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("applies placed_at date ranges on cursor pages", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 6, { placedAt: (index) => 1_000 * (index + 1) });

    const { seen } = await collectAll(t, {
      placed_from: 2_000,
      placed_to: 5_000,
    });

    expect(seen).toHaveLength(4);
  });

  it("supports capped offset compatibility and rejects deep offsets", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 205);

    const first = await t.query(api.orders.list, { limit: 2, offset: 0 });
    expect(first.data).toHaveLength(2);
    expect(first.total).toBe(205);
    expect(first.totalIsExact).toBe(true);

    const deep = await t.query(api.orders.list, { limit: 1, offset: 200 });
    expect(deep.data).toHaveLength(1);

    await expect(
      t.query(api.orders.list, { limit: 1, offset: 201 }),
    ).rejects.toThrow(/offset pagination is only supported up to 200/);
  });

  it("rejects invalid cursors predictably", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 3);

    await expect(
      t.query(api.orders.list, { limit: 2, cursor: "not-a-cursor" }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects a cursor reused against a different filter", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 6, {
      status: (index) => (index % 2 === 0 ? "confirmed" : "cancelled"),
    });
    const first = await t.query(api.orders.list, {
      status: "confirmed",
      limit: 1,
    });
    // Defined outcome: Convex cursor validation rejects cross-query reuse.
    await expect(
      t.query(api.orders.list, {
        status: "cancelled",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("rejects a search cursor reused against a different search term", async () => {
    const t = convexTest({ schema, modules });
    await seedEnv(t, 6, {
      searchText: (index) =>
        index % 2 === 0 ? `needle order ${index}` : `haystack order ${index}`,
    });
    const first = await t.query(api.orders.list, {
      search: "needle",
      limit: 1,
    });
    await expect(
      t.query(api.orders.list, {
        search: "haystack",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("keeps page work constant while unrelated historical orders grow", async () => {    const target = Array.from({ length: 10 }, (_, index) =>
      order(`target_${index}`, "store_a", `customer_${index}`, 10_000 - index),
    );
    const unrelated = Array.from({ length: 2_000 }, (_, index) =>
      order(`old_${index}`, "store_b", `other_${index}`, index),
    );
    const db = new FakeConvexDb({
      orders: [...target, ...unrelated],
      listCounts: [
        doc("listCounts", {
          _id: "lc_store_a_growth",
          scope: "orders",
          key: "store:store_a",
          count: 10,
        }),
      ],
      customers: [],
      stores: [],
      order_items: [],
    });

    const result = await listHandler(
      { db },
      { store_id: "store_a" as Id<"stores">, limit: 5 },
    );

    expect(result.data).toHaveLength(5);
    expect(result.total).toBe(10);
    expect(
      db.stats.documentsReturned["orders.by_store_placed"],
    ).toBeLessThanOrEqual(6);
  });
});

describe("orders.list search with date windows", () => {
  async function seedWindowOrders(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "900",
        display_name: "Window Customer",
        status: "active",
        marketing_opt_in: false,
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
      return { customerId, storeId, addressId };
    });
  }

  async function insertMany(
    t: ReturnType<typeof convexTest>,
    env: { customerId: Id<"customers">; storeId: Id<"stores">; addressId: Id<"addresses"> },
    rows: { n: number; placedAt: number; status?: string }[],
  ) {
    await t.run(async (ctx) => {
      for (const row of rows) {
        await ctx.db.insert("orders", {
          order_number: `PM-WIN-${row.n}`,
          customer_id: env.customerId,
          store_id: env.storeId,
          address_id: env.addressId,
          delivery_mode: "express",
          status: row.status ?? "confirmed",
          payment_status: "paid",
          currency: "PHP",
          subtotal_amount: 1,
          discount_amount: 0,
          delivery_fee_amount: 0,
          total_amount: 1,
          item_count: 1,
          order_search_text: `needle order ${row.n}`,
          orderSummaryVersion: 2,
          placed_at: row.placedAt,
        });
      }
    });
  }

  it("returns complete pages when out-of-window matches come first", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedWindowOrders(t);
    // 60 matches outside the window (higher placed_at), 45 inside.
    await insertMany(
      t,
      env,
      Array.from({ length: 60 }, (_, i) => ({ n: i, placedAt: 100_000 + i })),
    );
    await insertMany(
      t,
      env,
      Array.from({ length: 45 }, (_, i) => ({
        n: 100 + i,
        placedAt: 1_000 + (i % 5),
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let lastTotal = -1;
    do {
      const page: any = await t.query(api.orders.list, {
        search: "needle",
        placed_from: 1_000,
        placed_to: 1_004,
        limit: 20,
        cursor,
      } as any);
      lastTotal = page.total;
      for (const row of page.data as any[]) {
        expect(row.placed_at).toBeGreaterThanOrEqual(1_000);
        expect(row.placed_at).toBeLessThanOrEqual(1_004);
        seen.push(row.order_number as string);
      }
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(lastTotal).toBe(45);
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
  });

  it("honors status and store filters together with the window", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedWindowOrders(t);
    const { storeId } = env;
    await insertMany(
      t,
      env,
      Array.from({ length: 10 }, (_, i) => ({
        n: i,
        placedAt: 1_000,
        status: i % 2 === 0 ? "confirmed" : "cancelled",
      })),
    );
    await insertMany(
      t,
      env,
      Array.from({ length: 10 }, (_, i) => ({ n: 10 + i, placedAt: 5_000 })),
    );

    const page = await t.query(api.orders.list, {
      search: "needle",
      status: "confirmed",
      store_id: storeId,
      placed_from: 500,
      placed_to: 1_500,
      limit: 50,
    });
    expect(page.total).toBe(5);
    expect(page.data).toHaveLength(5);
    expect(page.data.every((row: any) => row.status === "confirmed")).toBe(true);

    const empty = await t.query(api.orders.list, {
      search: "needle",
      placed_from: 9_000,
      placed_to: 9_500,
      limit: 50,
    });
    expect(empty).toMatchObject({ total: 0, hasMore: false });
    expect(empty.data).toHaveLength(0);
  });

  it("rejects a window cursor reused with changed dates", async () => {
    const t = convexTest({ schema, modules });
    const env = await seedWindowOrders(t);
    await insertMany(
      t,
      env,
      Array.from({ length: 5 }, (_, i) => ({ n: i, placedAt: 1_000 + i })),
    );
    const first = await t.query(api.orders.list, {
      search: "needle",
      placed_from: 1_000,
      placed_to: 1_001,
      limit: 1,
    });
    expect(first.data).toHaveLength(1);
    await expect(
      t.query(api.orders.list, {
        search: "needle",
        placed_from: 1_002,
        placed_to: 1_004,
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/cursor/i);
    // identical window works
    const second = await t.query(api.orders.list, {
      search: "needle",
      placed_from: 1_000,
      placed_to: 1_001,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.data).toHaveLength(1);
    expect(second.data[0].order_number).not.toBe(first.data[0].order_number);
  });
});
