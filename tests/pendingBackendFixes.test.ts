import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (name: string) => readFileSync(new URL(`../convex/${name}`, import.meta.url), "utf8");
describe("pending backend invariant fixes", () => {
  it("bounds promotions", () => { const s = read("promotions.ts"); expect(s).toContain('withIndex("by_kind_starts"'); expect(s).not.toContain('query("promotion_targets")\n      .collect()'); });
  it("guards category ancestry", () => { const s = read("categories.ts"); expect(s).toContain("const visited = new Set<string>()"); expect(s).toContain("CATEGORY_ANCESTRY_DEPTH_LIMIT"); });
  it("repairs default SKU invariants", () => { const s = read("skus.ts"); expect(s).toContain("reconcileProductDefault(ctx, sku.product_id)"); expect(s).toContain("reconcileProductDefault(ctx, nextProductId"); });
  it("isolates SKU-center rows", () => { const s = read("quickInventory.ts"); expect(s).toContain('.eq("sku", sku).eq("fulfillmentCenterId", centerId)'); expect(s).toContain("reconcileSkuCenterDuplicates"); });
  it("bounds reservation expiry", () => { const s = read("quickInventory.ts"); expect(s).toContain('withIndex("by_status_expiry"'); expect(s).toContain("RESERVATION_EXPIRY_BATCH_LIMIT"); });
});
