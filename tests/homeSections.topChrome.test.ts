import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

function testConvex() {
  return convexTest({ schema, modules });
}

type TestCtx = ReturnType<typeof testConvex>;

async function insertSection(t: TestCtx, section: Record<string, unknown>) {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("home_sections", {
        isActive: true,
        allowEmpty: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...section,
      } as any),
  );
}

async function insertDefaultChrome(t: TestCtx) {
    const header = await insertSection(t, {
      key: "header_default",
      kind: "header",
      tab: "All",
      sortOrder: 0,
      backgroundColor: "#FAFAFA",
      backgroundImage: "https://cdn.example.com/home-chrome.jpg",
      config: { showLocation: true, showProfile: true, showCart: true, variant: "default" },
    });
  const searchBar = await insertSection(t, {
    key: "search_bar_default",
    kind: "search_bar",
    tab: "All",
    sortOrder: 10,
    config: { placeholder: "Search", stickyOnScroll: false },
  });
  const categoryTabs = await insertSection(t, {
    key: "category_tabs_default",
    kind: "category_tabs",
    tab: "All",
    sortOrder: 20,
    config: { tabs: ["All"], defaultTab: "All" },
  });
  return { header, searchBar, categoryTabs };
}

describe("homeSections top-chrome ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns top chrome first even when a body section has a lower sortOrder", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);
    await insertSection(t, {
      key: "bestsellers_default",
      kind: "bestseller_grid",
      tab: "All",
      sortOrder: 5,
    });
    await insertSection(t, { key: "hero_default", kind: "hero_banner", tab: "All", sortOrder: 30 });

    const result = await t.query(api.homeSections.list, { tab: "All" });
    expect(result.data.map((section: any) => section.kind)).toEqual([
      "header",
      "search_bar",
      "category_tabs",
      "bestseller_grid",
      "hero_banner",
    ]);
  });

  it("forces sticky config for search_bar/category_tabs and non-sticky header", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);

    const result = await t.query(api.homeSections.list, { tab: "All" });
    const byKind = Object.fromEntries(result.data.map((section: any) => [section.kind, section]));
    expect(byKind.search_bar.config.stickyOnScroll).toBe(true);
    expect(byKind.category_tabs.config.stickyOnScroll).toBe(true);
    expect(byKind.header.config.stickyOnScroll).toBe(false);
  });

  it("returns shared top-chrome background values from the header without per-section conflicts", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);

    const result = await t.query(api.homeSections.list, { tab: "All" });
    const byKind = Object.fromEntries(result.data.map((section: any) => [section.kind, section]));

    expect(byKind.header.backgroundColor).toBe("#FAFAFA");
    expect(byKind.header.backgroundImage).toBe("https://cdn.example.com/home-chrome.jpg");
    expect(byKind.header.config.backgroundImage).toBe("https://cdn.example.com/home-chrome.jpg");
    expect(byKind.search_bar.backgroundColor).toBeUndefined();
    expect(byKind.search_bar.backgroundImage).toBeUndefined();
    expect(byKind.search_bar.config.backgroundImage).toBeUndefined();
    expect(byKind.category_tabs.backgroundColor).toBeUndefined();
    expect(byKind.category_tabs.backgroundImage).toBeUndefined();
    expect(byKind.category_tabs.config.backgroundImage).toBeUndefined();
  });

  it("dedupes duplicate top-chrome kinds within a tab", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);
    await insertSection(t, { key: "header_alt", kind: "header", tab: "All", sortOrder: 1 });

    const result = await t.query(api.homeSections.list, { tab: "All" });
    expect(result.data.filter((section: any) => section.kind === "header")).toHaveLength(1);
    expect(result.data[0].key).toBe("header_default");
  });

  it("falls back to All tab top chrome for tabs that only define body sections", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);
    await insertSection(t, {
      key: "grocery_category_grid",
      kind: "category_grid",
      tab: "Grocery",
      sortOrder: 30,
    });

    const result = await t.query(api.homeSections.list, { tab: "Grocery" });
    expect(result.data.map((section: any) => section.kind)).toEqual([
      "header",
      "search_bar",
      "category_tabs",
      "category_grid",
    ]);
    expect(result.data.every((section: any) => section.tab === "Grocery")).toBe(true);
  });

  it("keeps a tab's own top chrome and only fills in the missing kinds", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);
    await insertSection(t, {
      key: "grocery_header",
      kind: "header",
      tab: "Grocery",
      sortOrder: 0,
      config: { variant: "compact" },
    });
    await insertSection(t, {
      key: "grocery_category_grid",
      kind: "category_grid",
      tab: "Grocery",
      sortOrder: 30,
    });

    const result = await t.query(api.homeSections.list, { tab: "Grocery" });
    expect(result.data.map((section: any) => section.kind)).toEqual([
      "header",
      "search_bar",
      "category_tabs",
      "category_grid",
    ]);
    expect(result.data[0].key).toBe("grocery_header");
    expect(result.data[1].key).toBe("search_bar_default");
    expect(result.data[2].key).toBe("category_tabs_default");
  });

  it("rejects body sections saved inside the reserved top-chrome sort band", async () => {
    const t = testConvex();
    await expect(
      t.mutation(api.homeSections.createSection, {
        key: "bad_hero",
        kind: "hero_banner",
        tab: "All",
        sortOrder: 15,
      }),
    ).rejects.toThrow(/reserved for top chrome/);
  });

  it("rejects body sections updated into the reserved top-chrome sort band", async () => {
    const t = testConvex();
    const hero = await insertSection(t, {
      key: "hero_default",
      kind: "hero_banner",
      tab: "All",
      sortOrder: 30,
    });
    await expect(
      t.mutation(api.homeSections.updateSection, {
        id: hero,
        patch: { sortOrder: 5 },
      }),
    ).rejects.toThrow(/reserved for top chrome/);
  });

  it("rejects duplicate top-chrome sections per tab unless explicitly allowed", async () => {
    const t = testConvex();
    await insertDefaultChrome(t);
    await expect(
      t.mutation(api.homeSections.createSection, {
        key: "header_second",
        kind: "header",
        tab: "All",
        sortOrder: 0,
      }),
    ).rejects.toThrow(/already has a header section/);

    const id = await t.mutation(api.homeSections.createSection, {
      key: "header_second",
      kind: "header",
      tab: "All",
      sortOrder: 0,
      allowDuplicateTopChrome: true,
    });
    expect(id).toBeTruthy();
  });

  it("reorders sections into canonical top-chrome-first sort orders", async () => {
    const t = testConvex();
    const { header, searchBar, categoryTabs } = await insertDefaultChrome(t);
    const hero = await insertSection(t, {
      key: "hero_default",
      kind: "hero_banner",
      tab: "All",
      sortOrder: 30,
    });
    const grid = await insertSection(t, {
      key: "bestsellers_default",
      kind: "bestseller_grid",
      tab: "All",
      sortOrder: 40,
    });

    await expect(
      t.mutation(api.homeSections.reorderSections, {
        orderedIds: [hero, header, searchBar, categoryTabs, grid],
      }),
    ).rejects.toThrow(/must be ordered before all body sections/);

    await t.mutation(api.homeSections.reorderSections, {
      orderedIds: [header, searchBar, categoryTabs, grid, hero],
    });

    const result = await t.query(api.homeSections.list, { tab: "All" });
    expect(
      result.data.map((section: any) => [section.kind, section.sortOrder]),
    ).toEqual([
      ["header", 0],
      ["search_bar", 10],
      ["category_tabs", 20],
      ["bestseller_grid", 30],
      ["hero_banner", 40],
    ]);
  });
});
