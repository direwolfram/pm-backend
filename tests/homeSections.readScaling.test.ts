import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../convex/homeSections.ts", import.meta.url), "utf8");

describe("home-section read bounds", () => {
  it("pages storefront rows before resolving catalog previews", () => {
    const list = source.slice(source.indexOf("export const list = query"), source.indexOf("export const get = query"));
    expect(list.indexOf("const page = sections.slice")).toBeGreaterThan(-1);
    expect(list.indexOf("buildResolutionContext(ctx, page")).toBeGreaterThan(list.indexOf("const page = sections.slice"));
    expect(list).not.toContain("buildResolutionContext(ctx, sections");
  });

  it("keeps admin preview resolution page-scoped", () => {
    const admin = source.slice(source.indexOf("export const adminList = query"), source.indexOf("export const createSection"));
    expect(admin.indexOf("const page = rows.slice")).toBeGreaterThan(-1);
    expect(admin).toContain("buildResolutionContext(ctx, page");
  });

  it("never full-collects catalog source tables during resolution", () => {
    const loaders = source.slice(source.indexOf("async function boundedSourceRows"), source.indexOf("const SECTION_MEDIA_PRODUCT_LIMIT"));
    for (const table of ["products", "categories", "promotions", "stores", "skus", "prices", "inventory"]) {
      expect(loaders).not.toContain(`query("${table}").collect()`);
    }
    expect(loaders.match(/HOME_SECTION_SOURCE_CAP \+ 1/g)?.length).toBe(7);
  });

  it("skips every catalog loader for static section kinds", () => {
    const resolver = source.slice(source.indexOf("async function resolveSection"), source.indexOf("async function responseForSection"));
    expect(resolver.indexOf("requiredForSection.size === 0")).toBeLessThan(resolver.indexOf("Promise.all(["));
  });
});
