import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedProductWithSku(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: "Transition Product",
      slug: `transition-product-${Math.random()}`,
      status: "active",
      rating_average: 0,
      rating_count: 0,
      sku_count: 1,
      total_stock: 0,
      productListSummaryVersion: 2,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    const skuId = await ctx.db.insert("skus", {
      product_id: productId,
      sku_code: `TR-${Math.random()}`,
      variant_label: "V",
      sort_order: 0,
      is_default: true,
      is_active: true,
    });
    await ctx.db.patch(productId, { default_sku_id: skuId });
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
    return { productId, skuId, storeId };
  });
}

async function insertPrices(
  t: ReturnType<typeof convexTest>,
  skuId: Id<"skus">,
  productId: Id<"products">,
  count: number,
  opts: { startsAt: (i: number) => number; endsAt?: (i: number) => number | undefined; storeId?: Id<"stores">; price?: (i: number) => number },
) {
  await t.run(async (ctx) => {
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("prices", {
        sku_id: skuId,
        product_id: productId,
        store_id: opts.storeId,
        currency: "PHP",
        sale_price: opts.price?.(index) ?? 10,
        starts_at: opts.startsAt(index),
        ends_at: opts.endsAt?.(index),
        priceSummaryVersion: 2,
      });
    }
  });
}

async function mirrorRows(t: ReturnType<typeof convexTest>, skuId: Id<"skus">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("pricesActive")
      .withIndex("by_sku", (q) => q.eq("sku_id", skuId))
      .collect(),
  );
}

/**
 * Prices inserted directly (bypassing prices.upsert) are legacy rows: the
 * migration backfill syncs their mirrors and writes their journal records,
 * exactly as it would on a real deployment.
 */
async function backfillTransitions(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.prices.backfillPriceTransitions, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("due-time activation journal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activates a price created months before its starts_at", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    const startsAt = Date.now() + 90 * 24 * 3_600_000;
    await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 42,
      starts_at: startsAt,
    });

    // Many drains pass before the activation is due; none may strand it.
    for (let week = 0; week < 12; week += 1) {
      vi.setSystemTime(Date.now() + 7 * 24 * 3_600_000);
      const run = await t.mutation(internal.prices.scheduleTransition, {});
      expect(run.drained).toBe(true);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    expect(await mirrorRows(t, skuId)).toHaveLength(0);

    // Cross into the materialization lookahead: the mirror appears before
    // starts_at so list reads are correct the instant it activates.
    vi.setSystemTime(startsAt - 24 * 3_600_000);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mirrorRows(t, skuId)).toHaveLength(1);

    // At starts_at the stored summary refreshes to the new price.
    vi.setSystemTime(startsAt + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(42);
  });

  it("journals legacy direct-inserted future prices via the backfill", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    const startsAt = Date.now() + 30 * 24 * 3_600_000;
    await insertPrices(t, skuId, productId, 3, {
      startsAt: () => startsAt,
      price: () => 11,
    });

    let result = await t.mutation(internal.prices.backfillPriceTransitions, {
      limit: 2,
    });
    expect(result.done).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Re-running the whole backfill is a no-op (idempotent).
    result = await t.mutation(internal.prices.backfillPriceTransitions, {});
    expect(result).toMatchObject({ done: true, synced: 0, journaled: 0 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    vi.setSystemTime(startsAt + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(3);
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(3);
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(11);
  });

  it("moves the activation when starts_at is edited", async () => {
    const t = convexTest({ schema, modules });
    const { skuId } = await seedProductWithSku(t);
    const priceId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 30,
      starts_at: Date.now() + 3_600_000,
    });
    // Push the activation two days out.
    await t.mutation(api.prices.upsert, {
      id: priceId,
      sku_id: skuId,
      sale_price: 30,
      starts_at: Date.now() + 2 * 24 * 3_600_000,
    });

    vi.setSystemTime(Date.now() + 3_600_000 + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Not active at the original time (mirror may be pre-materialized inside
    // the lookahead window, but the price itself is not yet time-active).
    const early = await t.run(async (ctx) => ctx.db.get(priceId));
    expect(early?.starts_at).toBeGreaterThan(Date.now());

    vi.setSystemTime(Date.now() + 2 * 24 * 3_600_000 + 1);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].sale_price).toBe(30);
    // No journal rows remain for the processed price.
    const pending = await t.run(async (ctx) =>
      ctx.db
        .query("priceTransitions")
        .withIndex("by_price", (q) => q.eq("price_id", priceId))
        .collect(),
    );
    expect(pending).toHaveLength(0);
  });

  it("cancels the activation when the price is removed before starts_at", async () => {
    const t = convexTest({ schema, modules });
    const { skuId } = await seedProductWithSku(t);
    const priceId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      sale_price: 30,
      starts_at: Date.now() + 3_600_000,
    });
    await t.mutation(api.prices.remove, { id: priceId });

    vi.setSystemTime(Date.now() + 4_000_000);
    const run = await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(run).toMatchObject({ expired: 0, drained: true });
    expect(await mirrorRows(t, skuId)).toHaveLength(0);
  });

  it("handles >200 activations at exactly the same starts_at without duplicates", async () => {
    const t = convexTest({ schema, modules });
    const { skuId } = await seedProductWithSku(t);
    const startsAt = Date.now() + 3_600_000;
    for (let index = 0; index < 210; index += 1) {
      await t.mutation(api.prices.upsert, {
        sku_id: skuId,
        sale_price: 7,
        starts_at: startsAt,
      });
    }
    vi.setSystemTime(startsAt + 1);
    // Overlapping runs: process the same due set concurrently.
    const a = await t.mutation(internal.prices.scheduleTransition, {});
    const b = await t.mutation(internal.prices.scheduleTransition, {});
    expect(a.drained).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    void b;

    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(210);
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(210);
    // Repeated runs afterwards are fully idempotent: no mirror changes, no
    // summary recomputes, no rewrites.
    const again = await t.mutation(internal.prices.scheduleTransition, {});
    expect(again).toMatchObject({
      expired: 0,
      activated: 0,
      refreshed: 0,
      drained: true,
    });
    expect(await mirrorRows(t, skuId)).toHaveLength(210);
  });
});

describe("price transition drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains more than 200 simultaneous activations across continuations", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    const startsAt = Date.now() + 3_600_000;
    await insertPrices(t, skuId, productId, 250, {
      startsAt: () => startsAt,
      price: () => 10,
    });
    // one later-starting price wins deterministically
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => startsAt + 1_000,
      price: () => 77,
    });
    await backfillTransitions(t);

    vi.setSystemTime(Date.now() + 7_200_000);
    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.drained).toBe(false);
    expect(first.remainingMayExist).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(251);
    // unique per price
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(251);

    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(77);

    // a repeated cron run is a no-op
    const again = await t.mutation(internal.prices.scheduleTransition, {});
    expect(again).toMatchObject({ expired: 0, activated: 0, drained: true });
  });

  it("drains more than 200 expirations and stops them contributing", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 230, {
      startsAt: () => Date.now() - 10_000,
      endsAt: () => Date.now() + 3_600_000,
      price: () => 5,
    });
    // one persistent base price
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 10_000,
      price: () => 9,
    });
    await backfillTransitions(t);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await mirrorRows(t, skuId)).toHaveLength(231);

    // all 230 expire
    vi.setSystemTime(Date.now() + 3_600_000 + 1);
    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.expired).toBe(200);
    expect(first.drained).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(1);
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(9);
  });

  it("resumes an interrupted drain instead of starting over", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 450, {
      startsAt: () => Date.now() + 3_600_000,
      price: () => 3,
    });
    await backfillTransitions(t);
    vi.setSystemTime(Date.now() + 7_200_000);

    // Overlapping root runs each drain a disjoint due batch; nothing is
    // processed twice because journal rows are deleted transactionally.
    // (Mirrors already exist — starts_at was inside the materialization
    // lookahead at backfill time — so `activated` stays 0 and progress is
    // measured by the drain flags.)
    const a = await t.mutation(internal.prices.scheduleTransition, {});
    const b = await t.mutation(internal.prices.scheduleTransition, {});
    expect(a.drained).toBe(false);
    expect(a.remainingMayExist).toBe(true);
    expect(b.drained).toBe(false);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const mirrors = await mirrorRows(t, skuId);
    expect(mirrors).toHaveLength(450);
    expect(new Set(mirrors.map((m) => m.price_id)).size).toBe(450);
  });

  it("keeps mirrors consistent when prices are edited during the drain", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 250, {
      startsAt: () => Date.now() + 1_000,
      price: () => 3,
    });
    await backfillTransitions(t);
    vi.setSystemTime(Date.now() + 2_000);

    const first = await t.mutation(internal.prices.scheduleTransition, {});
    expect(first.drained).toBe(false);

    // edit + insert mid-drain through the public mutation
    const editedId = await t.mutation(api.prices.upsert, {
      sku_id: skuId,
      store_id: storeId,
      sale_price: 55,
      starts_at: Date.now() - 500,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mirrors = await mirrorRows(t, skuId);
    const edited = mirrors.find((m) => m.price_id === editedId);
    expect(edited).toMatchObject({ sale_price: 55, store_id: storeId });
    // base prices win over the single store price
    const product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(3);

    // removing the price removes its mirror
    await t.mutation(api.prices.remove, { id: editedId });
    const after = await mirrorRows(t, skuId);
    expect(after.find((m) => m.price_id === editedId)).toBeUndefined();
  });

  it("preserves base-over-store precedence and single-store fallback", async () => {
    const t = convexTest({ schema, modules });
    const { productId, skuId, storeId } = await seedProductWithSku(t);
    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 1_000,
      storeId,
      price: () => 5,
    });
    await backfillTransitions(t);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(5);

    await insertPrices(t, skuId, productId, 1, {
      startsAt: () => Date.now() - 900,
      price: () => 8,
    });
    await backfillTransitions(t);
    await t.mutation(internal.prices.scheduleTransition, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    product = await t.run(async (ctx) => await ctx.db.get(productId));
    expect(product?.default_price).toBe(8);
  });
});
