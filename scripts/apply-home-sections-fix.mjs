import fs from "node:fs";

const file = "convex/homeSections.ts";
let source = fs.readFileSync(file, "utf8");

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing patch target: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'const SECTION_REFERENCE_LIMIT = 50;\n',
  'const SECTION_REFERENCE_LIMIT = 50;\nconst HOME_SECTION_SOURCE_CAP = 512;\nconst HOME_SECTION_PAGE_LIMIT = 100;\n',
  "source caps",
);

const oldLoaders = `async function loadProducts(context: ResolutionContext): Promise<ProductDoc[]> {
  if (!context.required.has("products")) return [];
  context.products ??= context.db.query("products").collect() as Promise<ProductDoc[]>;
  return await context.products;
}

async function loadCategories(context: ResolutionContext): Promise<CategoryDoc[]> {
  if (!context.required.has("categories")) return [];
  context.categories ??= context.db.query("categories").collect() as Promise<CategoryDoc[]>;
  return await context.categories;
}

async function loadPromotions(context: ResolutionContext): Promise<PromotionDoc[]> {
  if (!context.required.has("promotions")) return [];
  context.promotions ??= context.db.query("promotions").collect() as Promise<PromotionDoc[]>;
  return await context.promotions;
}

async function loadStores(context: ResolutionContext): Promise<StoreDoc[]> {
  if (!context.required.has("stores")) return [];
  context.stores ??= context.db.query("stores").collect() as Promise<StoreDoc[]>;
  return await context.stores;
}

async function loadSkus(context: ResolutionContext): Promise<SkuDoc[]> {
  if (!context.required.has("skus")) return [];
  context.skus ??= context.db.query("skus").collect() as Promise<SkuDoc[]>;
  return await context.skus;
}

async function loadPrices(context: ResolutionContext): Promise<PriceDoc[]> {
  if (!context.required.has("prices")) return [];
  context.prices ??= context.db.query("prices").collect() as Promise<PriceDoc[]>;
  return await context.prices;
}

async function loadInventory(context: ResolutionContext): Promise<InventoryDoc[]> {
  if (!context.required.has("inventory")) return [];
  context.inventory ??= context.db.query("inventory").collect() as Promise<InventoryDoc[]>;
  return await context.inventory;
}`;

const newLoaders = `async function boundedSourceRows<T>(
  table: string,
  read: () => Promise<T[]>,
): Promise<T[]> {
  const rows = await read();
  if (rows.length > HOME_SECTION_SOURCE_CAP) {
    throw new Error(
      \`Home-section source \${table} exceeded the \${HOME_SECTION_SOURCE_CAP}-row bound; add narrower section references or an indexed resolver\`,
    );
  }
  return rows;
}

async function loadProducts(context: ResolutionContext): Promise<ProductDoc[]> {
  if (!context.required.has("products")) return [];
  context.products ??= boundedSourceRows("products", () =>
    context.db
      .query("products")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.products;
}

async function loadCategories(context: ResolutionContext): Promise<CategoryDoc[]> {
  if (!context.required.has("categories")) return [];
  context.categories ??= boundedSourceRows("categories", () =>
    context.db.query("categories").take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.categories;
}

async function loadPromotions(context: ResolutionContext): Promise<PromotionDoc[]> {
  if (!context.required.has("promotions")) return [];
  context.promotions ??= boundedSourceRows("promotions", () =>
    context.db
      .query("promotions")
      .withIndex("by_active", (q: any) => q.eq("is_active", true))
      .take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.promotions;
}

async function loadStores(context: ResolutionContext): Promise<StoreDoc[]> {
  if (!context.required.has("stores")) return [];
  context.stores ??= boundedSourceRows("stores", () =>
    context.db
      .query("stores")
      .withIndex("by_status", (q: any) => q.eq("status", "active"))
      .take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.stores;
}

async function loadSkus(context: ResolutionContext): Promise<SkuDoc[]> {
  if (!context.required.has("skus")) return [];
  context.skus ??= boundedSourceRows("skus", () =>
    context.db.query("skus").take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.skus;
}

async function loadPrices(context: ResolutionContext): Promise<PriceDoc[]> {
  if (!context.required.has("prices")) return [];
  context.prices ??= boundedSourceRows("prices", () =>
    context.db.query("prices").take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.prices;
}

async function loadInventory(context: ResolutionContext): Promise<InventoryDoc[]> {
  if (!context.required.has("inventory")) return [];
  context.inventory ??= boundedSourceRows("inventory", () =>
    context.db.query("inventory").take(HOME_SECTION_SOURCE_CAP + 1),
  );
  return await context.inventory;
}`;
replaceOnce(oldLoaders, newLoaders, "bounded source loaders");

source = source.replace(
  'const limit = Math.max(0, args.limit ?? 50);',
  'const limit = Math.min(Math.max(0, args.limit ?? 50), HOME_SECTION_PAGE_LIMIT);',
);
source = source.replace(
  'const limit = Math.max(0, args.limit ?? 200);',
  'const limit = Math.min(Math.max(0, args.limit ?? 100), HOME_SECTION_PAGE_LIMIT);',
);

const oldListResolution = `    sections = orderSectionsForDisplay(sections);

    const resolutionContext = buildResolutionContext(ctx, sections, args);
    const resolvedResponses = await Promise.all(
      sections.map(async (section) => ({
        section,
        response: await responseForSection(resolutionContext, section, args),
      })),
    );`;
const newListResolution = `    sections = orderSectionsForDisplay(sections);

    // Page primary rows before catalog resolution. total intentionally counts
    // visibility-qualified section rows; allowEmpty may remove a row from the
    // returned page, but can no longer force resolution of the entire feed.
    const total = sections.length;
    const page = sections.slice(offset, offset + limit);
    const resolutionContext = buildResolutionContext(ctx, page, args);
    const resolvedResponses = await Promise.all(
      page.map(async (section) => ({
        section,
        response: await responseForSection(resolutionContext, section, args),
      })),
    );`;
replaceOnce(oldListResolution, newListResolution, "storefront page-before-resolve");
replaceOnce(
  `      data: visibleResponses.slice(offset, offset + limit),
      total: visibleResponses.length,`,
  `      data: visibleResponses,
      total,`,
  "storefront response pagination",
);

fs.writeFileSync(file, source);

fs.writeFileSync(
  "tests/homeSections.readScaling.test.ts",
  `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nconst source = readFileSync(new URL("../convex/homeSections.ts", import.meta.url), "utf8");\n\ndescribe("home-section read bounds", () => {\n  it("pages storefront rows before resolving catalog previews", () => {\n    const list = source.slice(source.indexOf("export const list = query"), source.indexOf("export const get = query"));\n    expect(list.indexOf("const page = sections.slice")).toBeGreaterThan(-1);\n    expect(list.indexOf("buildResolutionContext(ctx, page")).toBeGreaterThan(list.indexOf("const page = sections.slice"));\n    expect(list).not.toContain("buildResolutionContext(ctx, sections");\n  });\n\n  it("keeps admin preview resolution page-scoped", () => {\n    const admin = source.slice(source.indexOf("export const adminList = query"), source.indexOf("export const createSection"));\n    expect(admin.indexOf("const page = rows.slice")).toBeGreaterThan(-1);\n    expect(admin).toContain("buildResolutionContext(ctx, page");\n  });\n\n  it("never full-collects catalog source tables during resolution", () => {\n    const loaders = source.slice(source.indexOf("async function boundedSourceRows"), source.indexOf("const SECTION_MEDIA_PRODUCT_LIMIT"));\n    for (const table of ["products", "categories", "promotions", "stores", "skus", "prices", "inventory"]) {\n      expect(loaders).not.toContain(\`query("\${table}").collect()\`);\n    }\n    expect(loaders.match(/HOME_SECTION_SOURCE_CAP \\+ 1/g)?.length).toBe(7);\n  });\n\n  it("skips every catalog loader for static section kinds", () => {\n    const resolver = source.slice(source.indexOf("async function resolveSection"), source.indexOf("async function responseForSection"));\n    expect(resolver.indexOf("requiredForSection.size === 0")).toBeLessThan(resolver.indexOf("Promise.all(["));\n  });\n});\n`,
);

fs.rmSync("scripts/apply-home-sections-fix.mjs");
fs.rmSync(".github/workflows/apply-home-sections-fix.yml");
