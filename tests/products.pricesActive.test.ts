import { describe, expect, it } from "vitest";
import { activePriceForSku } from "../convex/lib/productListSummaries";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function mirrorRows(skuId: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    doc("pricesActive", {
      _id: `pa_${skuId}_${index}`,
      sku_id: skuId,
      price_id: `price_${skuId}_${index}`,
      sale_price: 10 + index,
      starts_at: index + 1,
    }),
  );
}

function priceHistory(skuId: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    doc("prices", {
      _id: `price_${skuId}_${index}`,
      sku_id: skuId,
      product_id: "product_a",
      currency: "PHP",
      sale_price: 100 + index,
      starts_at: index + 1,
      ends_at: index + 2,
      priceSummaryVersion: 2,
    }),
  );
}

describe("activePriceForSku read bounds", () => {
  it("keeps pricesActive mirror reads constant as historical prices grow", async () => {
    const snapshots: Record<string, unknown>[] = [];
    for (const historyCount of [50, 5_000]) {
      const db = new FakeConvexDb({
        pricesActive: mirrorRows("sku_a", 3),
        prices: priceHistory("sku_a", historyCount),
      });
      const winner = await activePriceForSku({ db }, "sku_a", 2);
      expect(winner).toMatchObject({ sale_price: 11 });
      snapshots.push({
        mirrorDocs: db.stats.documentsReturned["pricesActive.by_sku"] ?? 0,
        priceDocs: db.stats.documentsReturned["prices.by_sku"] ?? 0,
        mirrorCollect: db.stats.collect["pricesActive.by_sku"] ?? 0,
      });
    }
    // The mirror read is one bounded take; the unbounded price history is
    // never touched while mirror rows exist.
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].mirrorDocs).toBe(3);
    expect(snapshots[0].priceDocs).toBe(0);
    expect(snapshots[0].mirrorCollect).toBe(1);
  });

  it("rejects an over-cap mirror domain explicitly instead of collecting unboundedly", async () => {
    const db = new FakeConvexDb({
      pricesActive: mirrorRows("sku_a", 1_001),
      prices: [],
    });
    await expect(activePriceForSku({ db }, "sku_a", 2)).rejects.toThrow(
      /active price mirror rows/,
    );
    expect(db.stats.documentsReturned["pricesActive.by_sku"]).toBe(1_001);
  });

  it("bounds the legacy fallback read and rejects over-cap price history", async () => {
    const db = new FakeConvexDb({
      pricesActive: [],
      prices: priceHistory("sku_a", 30),
    });
    const winner = await activePriceForSku({ db }, "sku_a", 1.5);
    expect(winner).toEqual({ sale_price: 100 });
    expect(db.stats.documentsReturned["prices.by_sku"]).toBe(30);

    const huge = new FakeConvexDb({
      pricesActive: [],
      prices: priceHistory("sku_a", 1_001),
    });
    await expect(activePriceForSku({ db: huge }, "sku_a", 2)).rejects.toThrow(
      /more than 1000 prices/,
    );
    expect(huge.stats.documentsReturned["prices.by_sku"]).toBe(1_001);
  });
});
