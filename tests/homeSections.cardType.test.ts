import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

type T = ReturnType<typeof convexTest>;

function sectionArgs(overrides?: Record<string, unknown>) {
  return {
    key: "featured_default",
    kind: "featured_products" as const,
    title: "Featured",
    tab: "All",
    sortOrder: 100,
    allowEmpty: true,
    ...overrides,
  };
}

async function createSection(t: T, overrides?: Record<string, unknown>) {
  return await t.mutation(api.homeSections.createSection, sectionArgs(overrides) as never);
}

async function rawCardType(t: T, id: Id<"home_sections">) {
  return await t.run(async (ctx) => (await ctx.db.get(id))?.card_type);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("home section card_type mutations", () => {
  it("stores 'overlap' when omitted on create", async () => {
    const t = convexTest({ schema, modules });
    const id = await createSection(t);
    expect(await rawCardType(t, id)).toBe("overlap");
  });

  it.each(["minimal", "small", "overlap"] as const)(
    "accepts and stores '%s'",
    async (cardType) => {
      const t = convexTest({ schema, modules });
      const id = await createSection(t, { card_type: cardType });
      expect(await rawCardType(t, id)).toBe(cardType);
    },
  );

  it("rejects invalid card_type values on create and update", async () => {
    const t = convexTest({ schema, modules });
    await expect(createSection(t, { card_type: "large" })).rejects.toThrow();
    const id = await createSection(t);
    await expect(
      t.mutation(api.homeSections.updateSection, {
        id,
        patch: { card_type: "huge" },
      } as never),
    ).rejects.toThrow();
    expect(await rawCardType(t, id)).toBe("overlap");
  });

  it("updates card_type and preserves it when the patch omits it", async () => {
    const t = convexTest({ schema, modules });
    const id = await createSection(t);
    await t.mutation(api.homeSections.updateSection, {
      id,
      patch: { card_type: "minimal" },
    });
    expect(await rawCardType(t, id)).toBe("minimal");
    await t.mutation(api.homeSections.updateSection, {
      id,
      patch: { title: "Renamed" },
    });
    expect(await rawCardType(t, id)).toBe("minimal");
  });

  it("legacy create/update aliases default and accept card_type", async () => {
    const t = convexTest({ schema, modules });
    const id = await t.mutation(api.homeSections.create, {
      title: "Legacy section",
      kind: "product_carousel",
    });
    expect(await rawCardType(t, id)).toBe("overlap");
    await t.mutation(api.homeSections.update, { id, card_type: "small" });
    expect(await rawCardType(t, id)).toBe("small");
  });
});

describe("home section card_type in API responses", () => {
  it("list and get always return a card_type, falling back to 'overlap'", async () => {
    const t = convexTest({ schema, modules });
    const modern = await createSection(t, { card_type: "small", key: "modern", sortOrder: 100 });
    // Legacy row written before the field existed (no card_type at all).
    const legacy = await t.run(
      async (ctx) =>
        await ctx.db.insert("home_sections", {
          key: "legacy",
          kind: "featured_products",
          title: "Legacy",
          tab: "All",
          sortOrder: 110,
          isActive: true,
          allowEmpty: true,
          createdAt: 1,
          updatedAt: 1,
        }),
    );

    const list = await t.query(api.homeSections.list, {});
    const byId = new Map(list.data.map((s) => [s.id, s]));
    expect(byId.get(modern)?.card_type).toBe("small");
    expect(byId.get(legacy)?.card_type).toBe("overlap");

    const detail = await t.query(api.homeSections.get, { id: legacy });
    expect(detail.card_type).toBe("overlap");

    const admin = await t.query(api.homeSections.adminList, {});
    const adminById = new Map(admin.data.map((s) => [s._id, s]));
    expect(adminById.get(modern)?.card_type).toBe("small");
    expect(adminById.get(legacy)?.card_type).toBe("overlap");
    expect(adminById.get(legacy)?.preview.card_type).toBe("overlap");
  });
});

describe("updateSection legacy sortOrder healing", () => {
  it("heals a legacy sub-chrome sortOrder echoed back by unrelated edits", async () => {
    const t = convexTest({ schema, modules });
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("home_sections", {
          key: "legacy_body",
          kind: "category_grid",
          title: "Beauty",
          tab: "All",
          sortOrder: 14,
          isActive: true,
          allowEmpty: true,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    // Unrelated edit (card_type) echoes the stored sortOrder 14 back.
    await t.mutation(api.homeSections.updateSection, {
      id,
      patch: { card_type: "small", sortOrder: 14 },
    });
    const row = await t.run(async (ctx) => await ctx.db.get(id));
    expect(row?.card_type).toBe("small");
    expect(row?.sortOrder).toBe(30);
    expect(row?.sort_order).toBe(30);
  });

  it("still rejects a deliberate new sub-chrome sortOrder", async () => {
    const t = convexTest({ schema, modules });
    const id = await createSection(t, { sortOrder: 100 });
    await expect(
      t.mutation(api.homeSections.updateSection, {
        id,
        patch: { sortOrder: 5 },
      }),
    ).rejects.toThrow(/sortOrder must be >= 30/);
  });
});

describe("homeSections.backfillCardType", () => {
  it("stamps the default on legacy rows, is resumable and idempotent", async () => {
    const t = convexTest({ schema, modules });
    const modern = await createSection(t, { card_type: "minimal", key: "modern", sortOrder: 100 });
    const legacyIds: Id<"home_sections">[] = [];
    for (let n = 0; n < 150; n += 1) {
      legacyIds.push(
        await t.run(
          async (ctx) =>
            await ctx.db.insert("home_sections", {
              key: `legacy_${n}`,
              kind: "featured_products",
              tab: "All",
              sortOrder: 200 + n,
              isActive: true,
              allowEmpty: true,
              createdAt: 1,
              updatedAt: 1,
            }),
        ),
      );
    }

    // First bounded chunk (limit 100): resumes via cursor.
    const first = await t.mutation(internal.homeSections.backfillCardType, {});
    expect(first).toMatchObject({ done: false, processed: 100 });
    const second = await t.mutation(internal.homeSections.backfillCardType, {
      cursor: first.nextCursor,
    });
    expect(second.done).toBe(true);

    for (const id of legacyIds) {
      expect(await rawCardType(t, id)).toBe("overlap");
    }
    // Rows that already carry a value are never clobbered.
    expect(await rawCardType(t, modern)).toBe("minimal");

    // Idempotent re-run: drains its chunks and patches nothing.
    await t.mutation(internal.homeSections.backfillCardType, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const final = await t.mutation(internal.homeSections.backfillCardType, {
      cursor: undefined,
      limit: 200,
    });
    expect(final).toMatchObject({ done: true, patched: 0 });
  });
});
