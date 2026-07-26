/* eslint-disable @typescript-eslint/no-explicit-any */
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { now } from "./helpers";
import type {
  BrandDoc,
  CategoryDoc,
  HomeSectionDoc,
  InventoryDoc,
  ProductDoc,
  PromotionDoc,
  SkuDoc,
  StoreDoc,
} from "./model";

const homeSectionKind = v.union(
  v.literal("header"),
  v.literal("search_bar"),
  v.literal("category_tabs"),
  v.literal("hero_banner"),
  v.literal("bestseller_grid"),
  v.literal("promo_banner"),
  v.literal("promo_carousel"),
  v.literal("shopping_list_card"),
  v.literal("category_grid"),
  v.literal("themed_product_section"),
  v.literal("product_carousel"),
  v.literal("featured_products"),
  v.literal("store_inventory_section"),
  v.literal("custom_cta"),
  v.literal("spacer"),
);

const timeWindow = v.object({ start: v.string(), end: v.string() });

const sectionFields = {
  key: v.optional(v.string()),
  kind: v.optional(homeSectionKind),
  title: v.optional(v.string()),
  subtitle: v.optional(v.string()),
  tab: v.optional(v.string()),
  sortOrder: v.optional(v.number()),
  isActive: v.optional(v.boolean()),
  allowEmpty: v.optional(v.boolean()),
  startsAt: v.optional(v.number()),
  endsAt: v.optional(v.number()),
  timezone: v.optional(v.string()),
  visibleDaysOfWeek: v.optional(v.array(v.number())),
  visibleTimeWindows: v.optional(v.array(timeWindow)),
  holidayTags: v.optional(v.array(v.string())),
  seasonalTags: v.optional(v.array(v.string())),
  storeIds: v.optional(v.array(v.id("stores"))),
  cityIds: v.optional(v.array(v.string())),
  regionIds: v.optional(v.array(v.string())),
  customerSegments: v.optional(v.array(v.string())),
  appVersion: v.optional(v.string()),
  minAppVersion: v.optional(v.string()),
  maxAppVersion: v.optional(v.string()),
  layoutVariant: v.optional(v.string()),
  backgroundColor: v.optional(v.string()),
  textColor: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  iconEmoji: v.optional(v.string()),
  maxItems: v.optional(v.number()),
  productIds: v.optional(v.array(v.id("products"))),
  categoryIds: v.optional(v.array(v.id("categories"))),
  promotionIds: v.optional(v.array(v.id("promotions"))),
  brandIds: v.optional(v.array(v.id("brands"))),
  config: v.optional(v.any()),
  resolvedData: v.optional(v.any()),
};

const listArgs = {
  tab: v.optional(v.string()),
  store_id: v.optional(v.id("stores")),
  city_id: v.optional(v.string()),
  region_id: v.optional(v.string()),
  customerSegment: v.optional(v.string()),
  holidayTags: v.optional(v.array(v.string())),
  seasonalTags: v.optional(v.array(v.string())),
  appVersion: v.optional(v.string()),
  now: v.optional(v.number()),
  limit: v.optional(v.number()),
  offset: v.optional(v.number()),
};

const productSectionKinds = new Set([
  "bestseller_grid",
  "themed_product_section",
  "product_carousel",
  "featured_products",
  "store_inventory_section",
]);

type ResolvedSectionData = Record<string, unknown> & {
  products?: unknown[];
  categories?: unknown[];
  promotions?: unknown[];
  stores?: unknown[];
  inventorySummary?: Record<string, unknown>;
};

const configRules: Record<string, Record<string, "string" | "number" | "boolean" | "string[]" | "number[]" | "object[]" | "any">> = {
  header: {
    showLocation: "boolean",
    showProfile: "boolean",
    showCart: "boolean",
    backgroundImageUrl: "string",
    variant: "string",
  },
  search_bar: {
    placeholder: "string",
    showMic: "boolean",
    showScanner: "boolean",
    stickyOnScroll: "boolean",
    variant: "string",
  },
  category_tabs: {
    tabs: "string[]",
    defaultTab: "string",
    stickyOnScroll: "boolean",
    variant: "string",
  },
  hero_banner: {
    title: "string",
    subtitle: "string",
    imageUrl: "string",
    ctaLabel: "string",
    ctaRoute: "string",
    variant: "string",
  },
  bestseller_grid: {
    categoryIds: "string[]",
    columns: "number",
    showMoreCount: "number",
    maxItems: "number",
  },
  promo_banner: {
    promotionIds: "string[]",
    title: "string",
    subtitle: "string",
    backgroundColor: "string",
    ctaLabel: "string",
    ctaRoute: "string",
  },
  promo_carousel: {
    promotionIds: "string[]",
    autoplay: "boolean",
    autoplayIntervalMs: "number",
    loop: "boolean",
    cardVariant: "string",
  },
  shopping_list_card: {
    title: "string",
    subtitle: "string",
    ctaLabel: "string",
    ctaRoute: "string",
    iconName: "string",
  },
  category_grid: {
    categoryIds: "string[]",
    columns: "number",
    sectionTitle: "string",
    showIcons: "boolean",
    maxItems: "number",
  },
  themed_product_section: {
    productIds: "string[]",
    themeName: "string",
    themeEmoji: "string",
    backgroundColor: "string",
    titleColor: "string",
    maxItems: "number",
  },
  product_carousel: {
    productIds: "string[]",
    categoryIds: "string[]",
    categoryId: "string",
    brandId: "string",
    title: "string",
    subtitle: "string",
    maxItems: "number",
    showSeeAll: "boolean",
    seeAllRoute: "string",
  },
  featured_products: {
    productIds: "string[]",
    title: "string",
    subtitle: "string",
    maxItems: "number",
    showSeeAll: "boolean",
  },
  store_inventory_section: {
    storeIds: "string[]",
    showInventorySummary: "boolean",
    showAvailability: "boolean",
    statusFilter: "string",
    maxItems: "number",
  },
  custom_cta: {
    title: "string",
    subtitle: "string",
    ctaLabel: "string",
    ctaRoute: "string",
    imageUrl: "string",
    backgroundColor: "string",
  },
  spacer: {
    height: "number",
  },
};

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSection(section: HomeSectionDoc): HomeSectionDoc {
  return {
    ...section,
    id: section.id ?? section._id,
    key: section.key ?? `legacy_${section._id}`,
    title: section.title ?? "",
    tab: section.tab ?? "All",
    sortOrder: section.sortOrder ?? section.sort_order ?? 0,
    isActive: section.isActive ?? section.is_active ?? false,
    allowEmpty: section.allowEmpty ?? false,
    config: section.config ?? {},
  };
}

function isWireframeSection(section: HomeSectionDoc): boolean {
  return section.tab === "Wireframes" || section.key?.startsWith("wireframe_") === true;
}

function sectionLimit(section: HomeSectionDoc): number | undefined {
  const config = (section.config ?? {}) as Record<string, unknown>;
  const configMax = typeof config.maxItems === "number" ? config.maxItems : undefined;
  return section.maxItems ?? configMax;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number(part));
  const pb = b.split(".").map((part) => Number(part));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function validateVersion(value: string | undefined, field: string) {
  if (value && !/^\d+(\.\d+){0,3}$/.test(value)) {
    throw new Error(`${field} must be a dotted numeric version like 1.2.3`);
  }
}

function validateTimeWindows(windows: { start: string; end: string }[] | undefined) {
  for (const window of asArray(windows)) {
    const start = minutesSinceMidnight(window.start);
    const end = minutesSinceMidnight(window.end);
    if (start === null || end === null) {
      throw new Error("visibleTimeWindows must use HH:mm time values");
    }
    if (start === end) {
      throw new Error("visibleTimeWindows start and end cannot be the same");
    }
  }
}

function minutesSinceMidnight(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timezoneParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const dayByName: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hour = value("hour") === "24" ? 0 : Number(value("hour"));
  return {
    day: dayByName[value("weekday")] ?? new Date(ms).getDay(),
    minute: hour * 60 + Number(value("minute")),
  };
}

function hasIntersection(configured: string[] | undefined, selected: string[] | undefined): boolean {
  if (!configured?.length) return true;
  const selectedSet = new Set(selected ?? []);
  return configured.some((value) => selectedSet.has(value));
}

function includesOrUnconfigured(configured: string[] | undefined, selected: string | undefined): boolean {
  if (!configured?.length) return true;
  return !!selected && configured.includes(selected);
}

function isInsideWindow(current: number, window: { start: string; end: string }) {
  const start = minutesSinceMidnight(window.start)!;
  const end = minutesSinceMidnight(window.end)!;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function isSectionVisible(
  section: HomeSectionDoc,
  args: {
    store_id?: string;
    city_id?: string;
    region_id?: string;
    customerSegment?: string;
    holidayTags?: string[];
    seasonalTags?: string[];
    appVersion?: string;
    now?: number;
  },
) {
  const current = args.now ?? Date.now();
  if (!section.isActive || section.archivedAt) return false;
  if (section.startsAt && current < section.startsAt) return false;
  if (section.endsAt && current >= section.endsAt) return false;

  const timezone = section.timezone || "Asia/Manila";
  const time = timezoneParts(current, timezone);
  if (section.visibleDaysOfWeek?.length && !section.visibleDaysOfWeek.includes(time.day)) {
    return false;
  }
  if (
    section.visibleTimeWindows?.length &&
    !section.visibleTimeWindows.some((window) => isInsideWindow(time.minute, window))
  ) {
    return false;
  }

  if (!hasIntersection(section.holidayTags, args.holidayTags)) return false;
  if (!hasIntersection(section.seasonalTags, args.seasonalTags)) return false;
  if (!includesOrUnconfigured(section.storeIds as string[] | undefined, args.store_id)) return false;
  if (!includesOrUnconfigured(section.cityIds, args.city_id)) return false;
  if (!includesOrUnconfigured(section.regionIds, args.region_id)) return false;
  if (!includesOrUnconfigured(section.customerSegments, args.customerSegment)) return false;
  if (section.minAppVersion && (!args.appVersion || compareVersions(args.appVersion, section.minAppVersion) < 0)) {
    return false;
  }
  if (section.maxAppVersion && (!args.appVersion || compareVersions(args.appVersion, section.maxAppVersion) > 0)) {
    return false;
  }
  return true;
}

function isSectionScheduledNow(section: HomeSectionDoc, current: number) {
  if (!section.isActive || section.archivedAt) return false;
  if (section.startsAt && current < section.startsAt) return false;
  if (section.endsAt && current >= section.endsAt) return false;
  const time = timezoneParts(current, section.timezone || "Asia/Manila");
  if (section.visibleDaysOfWeek?.length && !section.visibleDaysOfWeek.includes(time.day)) {
    return false;
  }
  if (
    section.visibleTimeWindows?.length &&
    !section.visibleTimeWindows.some((window) => isInsideWindow(time.minute, window))
  ) {
    return false;
  }
  return true;
}

function validateConfig(kind: string, config: unknown) {
  if (config === undefined) return;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config must be an object");
  }
  const rules = configRules[kind];
  if (!rules) throw new Error(`Unsupported section kind "${kind}"`);
  for (const [field, value] of Object.entries(config as Record<string, unknown>)) {
    const expected = rules[field];
    if (!expected) throw new Error(`config.${field} is not supported for ${kind}`);
    if (value === undefined || value === null) continue;
    if (expected === "string" && typeof value !== "string") throw new Error(`config.${field} must be a string`);
    if (expected === "number" && (typeof value !== "number" || value < 0)) throw new Error(`config.${field} must be a non-negative number`);
    if (expected === "boolean" && typeof value !== "boolean") throw new Error(`config.${field} must be a boolean`);
    if (expected === "string[]" && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
      throw new Error(`config.${field} must be an array of strings`);
    }
    if (expected === "number[]" && (!Array.isArray(value) || value.some((v) => typeof v !== "number"))) {
      throw new Error(`config.${field} must be an array of numbers`);
    }
    if (expected === "object[]" && !Array.isArray(value)) throw new Error(`config.${field} must be an array`);
  }
}

function configArray(config: unknown, key: string): string[] {
  const value = (config as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function configString(config: unknown, key: string): string | undefined {
  const value = (config as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function referencedIds(section: HomeSectionDoc) {
  return {
    productIds: unique([...(section.productIds as string[] | undefined ?? []), ...configArray(section.config, "productIds")]),
    categoryIds: unique([
      ...(section.categoryIds as string[] | undefined ?? []),
      ...configArray(section.config, "categoryIds"),
      configString(section.config, "categoryId"),
    ].filter(Boolean) as string[]),
    promotionIds: unique([...(section.promotionIds as string[] | undefined ?? []), ...configArray(section.config, "promotionIds")]),
    storeIds: unique([...(section.storeIds as string[] | undefined ?? []), ...configArray(section.config, "storeIds")]),
    brandIds: unique([
      ...(section.brandIds as string[] | undefined ?? []),
      configString(section.config, "brandId"),
    ].filter(Boolean) as string[]),
  };
}

async function ensureReferences(ctx: { db: any }, section: HomeSectionDoc) {
  const refs = referencedIds(section);
  const checks: [string, string, (doc: any) => boolean][] = [
    ...refs.productIds.map((id) => ["products", id, (doc: ProductDoc | null) => doc?.status === "active"] as [string, string, (doc: any) => boolean]),
    ...refs.categoryIds.map((id) => ["categories", id, (doc: CategoryDoc | null) => !!doc?.is_active] as [string, string, (doc: any) => boolean]),
    ...refs.promotionIds.map((id) => ["promotions", id, (doc: PromotionDoc | null) => !!doc?.is_active] as [string, string, (doc: any) => boolean]),
    ...refs.storeIds.map((id) => ["stores", id, (doc: StoreDoc | null) => doc?.status === "active"] as [string, string, (doc: any) => boolean]),
    ...refs.brandIds.map((id) => ["brands", id, (doc: BrandDoc | null) => !!doc?.is_active] as [string, string, (doc: any) => boolean]),
  ];
  const inactive: string[] = [];
  for (const [table, id, isActive] of checks) {
    const doc = await ctx.db.get(id as any);
    if (!doc) throw new Error(`Referenced ${table} document does not exist: ${id}`);
    if (!isActive(doc)) inactive.push(`${table}:${id}`);
  }
  if (section.isActive && inactive.length && !section.allowEmpty) {
    throw new Error(`Active section has inactive references: ${inactive.join(", ")}`);
  }
}

async function validateSection(
  ctx: { db: any },
  section: HomeSectionDoc,
  existingId?: string,
) {
  if (!section.kind) throw new Error("kind is required");
  if (!section.key?.trim()) throw new Error("key is required");
  if (!section.tab?.trim()) throw new Error("tab is required");
  if (typeof section.sortOrder !== "number") throw new Error("sortOrder is required");
  if (section.sortOrder < 0) throw new Error("sortOrder cannot be negative");
  if (section.startsAt && section.endsAt && section.startsAt >= section.endsAt) {
    throw new Error("startsAt must be before endsAt");
  }
  if (section.visibleDaysOfWeek?.some((day) => day < 0 || day > 6 || !Number.isInteger(day))) {
    throw new Error("visibleDaysOfWeek must contain integers 0 through 6");
  }
  validateTimeWindows(section.visibleTimeWindows);
  validateVersion(section.minAppVersion, "minAppVersion");
  validateVersion(section.maxAppVersion, "maxAppVersion");
  validateVersion(section.appVersion, "appVersion");
  if (
    section.minAppVersion &&
    section.maxAppVersion &&
    compareVersions(section.minAppVersion, section.maxAppVersion) > 0
  ) {
    throw new Error("minAppVersion must be <= maxAppVersion");
  }
  validateConfig(section.kind, section.config);
  const duplicate = await ctx.db
    .query("home_sections")
    .withIndex("by_key", (q: any) => q.eq("key", section.key))
    .first();
  if (duplicate && duplicate._id !== existingId) throw new Error(`Section key "${section.key}" is already used`);
  await ensureReferences(ctx, section);
}

function cleanPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function mergeSection(existing: HomeSectionDoc | null, patch: Partial<HomeSectionDoc>): HomeSectionDoc {
  return normalizeSection({
    ...(existing ?? {}),
    ...cleanPatch(patch),
  } as HomeSectionDoc);
}

function inventorySummary(rows: InventoryDoc[]) {
  return {
    total_skus: rows.length,
    in_stock: rows.filter((r) => r.status === "in_stock").length,
    low_stock: rows.filter((r) => r.status === "low_stock").length,
    out_of_stock: rows.filter((r) => r.status === "out_of_stock").length,
    unavailable: rows.filter((r) => r.status === "unavailable").length,
    total_units: rows.reduce((sum, r) => sum + r.quantity_available, 0),
    reserved_units: rows.reduce((sum, r) => sum + r.quantity_reserved, 0),
  };
}

async function resolveSection(
  ctx: { db: any },
  section: HomeSectionDoc,
  args: { store_id?: string; now?: number },
) {
  const refs = referencedIds(section);
  const current = args.now ?? Date.now();
  const maxItems = sectionLimit(section);
  const [products, categories, promotions, stores, skus, inventory] = await Promise.all([
    ctx.db.query("products").collect() as Promise<ProductDoc[]>,
    ctx.db.query("categories").collect() as Promise<CategoryDoc[]>,
    ctx.db.query("promotions").collect() as Promise<PromotionDoc[]>,
    ctx.db.query("stores").collect() as Promise<StoreDoc[]>,
    ctx.db.query("skus").collect() as Promise<SkuDoc[]>,
    ctx.db.query("inventory").collect() as Promise<InventoryDoc[]>,
  ]);

  const categoryId = configString(section.config, "categoryId");
  const brandId = configString(section.config, "brandId");
  let resolvedProducts = products.filter((p) => {
    if (p.status !== "active") return false;
    if (refs.productIds.length) return refs.productIds.includes(p._id);
    if (categoryId && p.primary_category_id !== categoryId) return false;
    if (brandId && p.brand_id !== brandId) return false;
    if (refs.categoryIds.length && !refs.categoryIds.includes(p.primary_category_id)) return false;
    if (refs.brandIds.length && p.brand_id && !refs.brandIds.includes(p.brand_id)) return false;
    return productSectionKinds.has(section.kind);
  });
  if (section.kind === "bestseller_grid" && !refs.productIds.length) {
    resolvedProducts.sort((a, b) => b.rating_count - a.rating_count);
  }
  if (args.store_id && productSectionKinds.has(section.kind)) {
    const activeSkuIdsByProduct = new Map<string, string[]>();
    for (const sku of skus) {
      if (!sku.is_active) continue;
      const ids = activeSkuIdsByProduct.get(sku.product_id) ?? [];
      ids.push(sku._id);
      activeSkuIdsByProduct.set(sku.product_id, ids);
    }
    const availableSkuIds = new Set(
      inventory
        .filter(
          (row) =>
            row.store_id === args.store_id &&
            row.status !== "out_of_stock" &&
            row.status !== "unavailable" &&
            row.quantity_available > row.quantity_reserved,
        )
        .map((row) => row.sku_id),
    );
    resolvedProducts = resolvedProducts.filter((product) =>
      (activeSkuIdsByProduct.get(product._id) ?? []).some((skuId) => availableSkuIds.has(skuId)),
    );
  }
  if (maxItems !== undefined) resolvedProducts = resolvedProducts.slice(0, maxItems);

  const resolvedCategories = categories
    .filter((c) => c.is_active && refs.categoryIds.includes(c._id))
    .slice(0, maxItems ?? (refs.categoryIds.length || undefined));
  const resolvedPromotions = promotions.filter(
    (p) =>
      p.is_active &&
      p.starts_at <= current &&
      p.ends_at > current &&
      refs.promotionIds.includes(p._id),
  );
  const effectiveStoreIds = refs.storeIds.length ? refs.storeIds : args.store_id ? [args.store_id] : [];
  const resolvedStores = stores.filter((s) => s.status === "active" && effectiveStoreIds.includes(s._id));
  const summaryStoreId = args.store_id ?? effectiveStoreIds[0];
  const summaryRows = summaryStoreId ? inventory.filter((row) => row.store_id === summaryStoreId) : [];

  return {
    products: resolvedProducts,
    categories: resolvedCategories,
    promotions: resolvedPromotions,
    stores: resolvedStores,
    inventorySummary:
      section.kind === "store_inventory_section" && summaryStoreId
        ? inventorySummary(summaryRows)
        : undefined,
  };
}

async function responseForSection(
  ctx: { db: any },
  section: HomeSectionDoc,
  args: { store_id?: string; now?: number },
) {
  const normalized = normalizeSection(section);
  const resolvedData = (normalized.resolvedData ?? await resolveSection(ctx, normalized, args)) as ResolvedSectionData;
  return {
    id: normalized._id,
    key: normalized.key,
    kind: normalized.kind,
    title: normalized.title,
    subtitle: normalized.subtitle,
    tab: normalized.tab,
    sortOrder: normalized.sortOrder ?? 0,
    layoutVariant: normalized.layoutVariant,
    config: normalized.config ?? {},
    resolvedData,
  };
}

export const tabs = query({
  args: {},
  handler: async (ctx) => {
    const current = Date.now();
    const sections = ((await ctx.db.query("home_sections").collect()) as HomeSectionDoc[])
      .map(normalizeSection)
      .filter((section) => !isWireframeSection(section))
      .filter((section) => isSectionScheduledNow(section, current))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return unique(sections.map((section) => section.tab));
  },
});

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => {
    const limit = Math.max(0, args.limit ?? 50);
    const offset = Math.max(0, args.offset ?? 0);
    const sections = ((await ctx.db.query("home_sections").collect()) as HomeSectionDoc[])
      .map(normalizeSection)
      .filter((section) => !isWireframeSection(section))
      .filter((section) => (!args.tab || section.tab === args.tab) && isSectionVisible(section, args))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    const visibleResponses = [];
    for (const section of sections) {
      const response = await responseForSection(ctx, section, args);
      if (
        productSectionKinds.has(section.kind) &&
        !section.allowEmpty &&
        (!response.resolvedData.products || response.resolvedData.products.length === 0)
      ) {
        continue;
      }
      if (
        (section.kind === "category_grid" || section.kind === "category_tabs") &&
        !section.allowEmpty &&
        (!response.resolvedData.categories || response.resolvedData.categories.length === 0) &&
        referencedIds(section).categoryIds.length
      ) {
        continue;
      }
      if (
        (section.kind === "promo_banner" || section.kind === "promo_carousel") &&
        !section.allowEmpty &&
        (!response.resolvedData.promotions || response.resolvedData.promotions.length === 0) &&
        referencedIds(section).promotionIds.length
      ) {
        continue;
      }
      visibleResponses.push(response);
    }
    return {
      data: visibleResponses.slice(offset, offset + limit),
      total: visibleResponses.length,
      limit,
      offset,
    };
  },
});

export const get = query({
  args: { id: v.id("home_sections") },
  handler: async (ctx, args) => {
    const section = (await ctx.db.get(args.id)) as HomeSectionDoc | null;
    if (!section) throw new Error("Home section not found");
    return await responseForSection(ctx, normalizeSection(section), {});
  },
});

export const adminList = query({
  args: {
    tab: v.optional(v.string()),
    kind: v.optional(homeSectionKind),
    state: v.optional(
      v.union(
        v.literal("all"),
        v.literal("active"),
        v.literal("inactive"),
        v.literal("scheduled"),
        v.literal("archived"),
      ),
    ),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(0, args.limit ?? 200);
    const offset = Math.max(0, args.offset ?? 0);
    const current = Date.now();
    let rows = ((await ctx.db.query("home_sections").collect()) as HomeSectionDoc[])
      .map(normalizeSection)
      .filter((section) => !isWireframeSection(section))
      .filter((section) => !args.tab || section.tab === args.tab)
      .filter((section) => !args.kind || section.kind === args.kind);
    if (args.state === "active") rows = rows.filter((s) => s.isActive && !s.archivedAt);
    if (args.state === "inactive") rows = rows.filter((s) => !s.isActive && !s.archivedAt);
    if (args.state === "scheduled") {
      rows = rows.filter((s) => !s.archivedAt && (!!s.startsAt && s.startsAt > current || !!s.endsAt && s.endsAt <= current));
    }
    if (args.state === "archived") rows = rows.filter((s) => !!s.archivedAt);
    if (!args.state || args.state === "all") rows = rows.filter((s) => !s.archivedAt);
    rows.sort((a, b) => a.tab.localeCompare(b.tab) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const data = [];
    for (const section of rows.slice(offset, offset + limit)) {
      data.push({
        ...section,
        preview: await responseForSection(ctx, section, {}),
      });
    }
    return { data, total: rows.length, limit, offset };
  },
});

export const createSection = mutation({
  args: sectionFields,
  handler: async (ctx, args) => {
    const t = now();
    const section = mergeSection(null, {
      ...args,
      isActive: args.isActive ?? true,
      allowEmpty: args.allowEmpty ?? false,
      timezone: args.timezone ?? "Asia/Manila",
      createdAt: t,
      updatedAt: t,
    } as Partial<HomeSectionDoc>);
    await validateSection(ctx, section);
    const id = await ctx.db.insert("home_sections", cleanPatch(section as any) as any);
    await ctx.db.patch(id, { id, updatedAt: now() });
    return id;
  },
});

async function updateSectionDocument(
  ctx: { db: any },
  id: string,
  patch: Partial<HomeSectionDoc>,
) {
  const existing = (await ctx.db.get(id as any)) as HomeSectionDoc | null;
  if (!existing) throw new Error("Home section not found");
  const next = mergeSection(existing, { ...patch, updatedAt: now() });
  await validateSection(ctx, next, id);
  await ctx.db.patch(id as any, cleanPatch({ ...patch, updatedAt: now() }));
  return id;
}

export const updateSection = mutation({
  args: { id: v.id("home_sections"), patch: v.object(sectionFields) },
  handler: async (ctx, args) => {
    return await updateSectionDocument(ctx, args.id, args.patch as Partial<HomeSectionDoc>);
  },
});

export const toggleSection = mutation({
  args: { id: v.id("home_sections"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    const existing = (await ctx.db.get(args.id)) as HomeSectionDoc | null;
    if (!existing) throw new Error("Home section not found");
    const next = mergeSection(existing, { isActive: args.isActive, updatedAt: now() });
    await validateSection(ctx, next, args.id);
    await ctx.db.patch(args.id, { isActive: args.isActive, is_active: args.isActive, updatedAt: now() });
    return args.id;
  },
});

export const reorderSections = mutation({
  args: { orderedIds: v.array(v.id("home_sections")) },
  handler: async (ctx, args) => {
    for (const [sortOrder, id] of args.orderedIds.entries()) {
      const existing = await ctx.db.get(id);
      if (!existing) throw new Error(`Home section not found: ${id}`);
      await ctx.db.patch(id, { sortOrder, sort_order: sortOrder, updatedAt: now() });
    }
    return args.orderedIds;
  },
});

export const duplicateSection = mutation({
  args: { id: v.id("home_sections") },
  handler: async (ctx, args) => {
    const existing = (await ctx.db.get(args.id)) as HomeSectionDoc | null;
    if (!existing) throw new Error("Home section not found");
    const source = normalizeSection(existing);
    let key = `${source.key}_copy`;
    let suffix = 2;
    while (await ctx.db.query("home_sections").withIndex("by_key", (q: any) => q.eq("key", key)).first()) {
      key = `${source.key}_copy_${suffix}`;
      suffix += 1;
    }
    const t = now();
    const duplicate = {
      ...source,
      id: undefined,
      key,
      title: source.title ? `${source.title} copy` : "Untitled copy",
      sortOrder: (source.sortOrder ?? 0) + 1,
      createdAt: t,
      updatedAt: t,
      archivedAt: undefined,
      sort_order: (source.sortOrder ?? 0) + 1,
      is_active: source.isActive,
    } as HomeSectionDoc;
    delete (duplicate as any)._id;
    delete (duplicate as any)._creationTime;
    await validateSection(ctx, duplicate);
    const id = await ctx.db.insert("home_sections", cleanPatch(duplicate as any) as any);
    await ctx.db.patch(id, { id, updatedAt: now() });
    return id;
  },
});

export const archiveSection = mutation({
  args: { id: v.id("home_sections") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Home section not found");
    await ctx.db.patch(args.id, { archivedAt: now(), updatedAt: now() });
    return args.id;
  },
});

export const restoreSection = mutation({
  args: { id: v.id("home_sections") },
  handler: async (ctx, args) => {
    const existing = (await ctx.db.get(args.id)) as HomeSectionDoc | null;
    if (!existing) throw new Error("Home section not found");
    const next = mergeSection(existing, { archivedAt: undefined, updatedAt: now() });
    await validateSection(ctx, next, args.id);
    await ctx.db.patch(args.id, { archivedAt: undefined, updatedAt: now() });
    return args.id;
  },
});

export const seedDefaults = mutation({
  args: { replaceExisting: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const t = now();
    const [products, categories, promotions, stores, brands] = await Promise.all([
      ctx.db.query("products").collect() as Promise<ProductDoc[]>,
      ctx.db.query("categories").collect() as Promise<CategoryDoc[]>,
      ctx.db.query("promotions").collect() as Promise<PromotionDoc[]>,
      ctx.db.query("stores").collect() as Promise<StoreDoc[]>,
      ctx.db.query("brands").collect() as Promise<BrandDoc[]>,
    ]);
    if (!products.length || !categories.length) {
      throw new Error("Seed products and categories before home sections");
    }
    if (args.replaceExisting) {
      const existing = await ctx.db.query("home_sections").collect();
      for (const section of existing) await ctx.db.delete(section._id);
    }
    const productByName = new Map(products.map((p) => [p.name, p._id]));
    const categoryByName = new Map(categories.map((c) => [c.name, c._id]));
    const brandByName = new Map(brands.map((b) => [b.name, b._id]));
    const promoIds = promotions.map((p) => p._id).slice(0, 4);
    const activeStores = stores.filter((s) => s.status === "active").map((s) => s._id);

    const pickProducts = (names: string[]) =>
      names.map((name) => productByName.get(name)).filter(Boolean) as any[];
    const pickCategories = (names: string[]) =>
      names.map((name) => categoryByName.get(name)).filter(Boolean) as any[];
    const defs: Partial<HomeSectionDoc>[] = [
      { key: "header_default", kind: "header", title: "Header", tab: "All", sortOrder: 0, config: { showLocation: true, showProfile: true, showCart: true, variant: "default" } },
      { key: "search_bar_default", kind: "search_bar", title: "Search", tab: "All", sortOrder: 10, config: { placeholder: "Search for groceries", showMic: true, showScanner: true, stickyOnScroll: true, variant: "rounded" } },
      { key: "category_tabs_default", kind: "category_tabs", title: "Tabs", tab: "All", sortOrder: 20, categoryIds: pickCategories(["Beverages", "Pantry", "Snacks", "Personal Care", "Household"]), config: { tabs: ["All", "Grocery", "Snacks", "Beauty"], defaultTab: "All", stickyOnScroll: true, variant: "pill" } },
      { key: "hero_default", kind: "hero_banner", title: "Fresh groceries in minutes", subtitle: "Daily essentials delivered fast.", tab: "All", sortOrder: 30, imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e", layoutVariant: "wide", config: { title: "Fresh groceries in minutes", subtitle: "Daily essentials delivered fast.", imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e", ctaLabel: "Shop now", ctaRoute: "/categories", variant: "wide" } },
      { key: "bestsellers_default", kind: "bestseller_grid", title: "Bestsellers", tab: "All", sortOrder: 40, maxItems: 8, productIds: pickProducts(["Lucky Me Pancit Canton Original", "Nescafé Classic 3-in-1 Coffee", "Coca-Cola Soft Drink", "Milo Chocolate Malt Drink"]), config: { columns: 2, showMoreCount: 4, maxItems: 8 } },
      { key: "promo_banner_match_time", kind: "promo_banner", title: "Match time deals", tab: "All", sortOrder: 50, promotionIds: promoIds.slice(0, 1), backgroundColor: "#B71C1C", visibleTimeWindows: [{ start: "17:00", end: "23:59" }], config: { promotionIds: promoIds.slice(0, 1), title: "Match time deals", subtitle: "Snacks and drinks for tonight.", backgroundColor: "#B71C1C", ctaLabel: "Grab deals", ctaRoute: "/promotions" } },
      { key: "promo_carousel_default", kind: "promo_carousel", title: "Promos", tab: "All", sortOrder: 60, promotionIds: promoIds, config: { promotionIds: promoIds, autoplay: true, autoplayIntervalMs: 4500, loop: true, cardVariant: "compact" } },
      { key: "shopping_list_card_default", kind: "shopping_list_card", title: "Shopping list", tab: "All", sortOrder: 70, config: { title: "Build your basket faster", subtitle: "Paste a list and we will find matches.", ctaLabel: "Open list", ctaRoute: "/shopping-list", iconName: "list-plus" } },
      { key: "grocery_category_grid", kind: "category_grid", title: "Grocery", tab: "Grocery", sortOrder: 80, categoryIds: pickCategories(["Beverages", "Pantry", "Instant Noodles", "Canned Goods"]), maxItems: 8, config: { columns: 4, sectionTitle: "Grocery", showIcons: true, maxItems: 8 } },
      { key: "snacks_category_grid", kind: "category_grid", title: "Snacks", tab: "Snacks", sortOrder: 90, categoryIds: pickCategories(["Snacks"]), maxItems: 8, config: { columns: 4, sectionTitle: "Snacks", showIcons: true, maxItems: 8 } },
      { key: "beauty_category_grid", kind: "category_grid", title: "Beauty", tab: "Beauty", sortOrder: 100, categoryIds: pickCategories(["Personal Care"]), maxItems: 8, config: { columns: 4, sectionTitle: "Beauty", showIcons: true, maxItems: 8 } },
      { key: "fresh_day_section", kind: "themed_product_section", title: "Fresh Day", tab: "All", sortOrder: 110, backgroundColor: "#E8F5E9", productIds: pickProducts(["Del Monte Pineapple Juice", "Milo Chocolate Malt Drink", "Lady's Choice Real Mayonnaise"]), maxItems: 6, config: { productIds: pickProducts(["Del Monte Pineapple Juice", "Milo Chocolate Malt Drink", "Lady's Choice Real Mayonnaise"]), themeName: "Fresh Day", themeEmoji: "🌿", backgroundColor: "#E8F5E9", titleColor: "#1B5E20", maxItems: 6 } },
      { key: "sweet_tooth_products", kind: "product_carousel", title: "Sweet tooth", tab: "Snacks", sortOrder: 120, productIds: pickProducts(["Oreo Chocolate Sandwich Cookies", "Milo Chocolate Malt Drink"]), maxItems: 8, config: { productIds: pickProducts(["Oreo Chocolate Sandwich Cookies", "Milo Chocolate Malt Drink"]), title: "Sweet tooth", showSeeAll: true, seeAllRoute: "/categories/snacks", maxItems: 8 } },
      { key: "cold_drinks_products", kind: "product_carousel", title: "Cold drinks", tab: "Grocery", sortOrder: 130, categoryIds: pickCategories(["Soft Drinks", "Juices"]), maxItems: 8, config: { categoryIds: pickCategories(["Soft Drinks", "Juices"]), title: "Cold drinks", showSeeAll: true, seeAllRoute: "/categories/beverages", maxItems: 8 } },
      { key: "featured_products", kind: "featured_products", title: "Featured products", tab: "All", sortOrder: 140, productIds: pickProducts(["Coca-Cola Soft Drink", "Lucky Me Pancit Canton Original", "Argentina Corned Beef", "Colgate Triple Action Toothpaste"]), maxItems: 8, config: { productIds: pickProducts(["Coca-Cola Soft Drink", "Lucky Me Pancit Canton Original", "Argentina Corned Beef", "Colgate Triple Action Toothpaste"]), title: "Featured products", subtitle: "Picked for this week", maxItems: 8, showSeeAll: true } },
      { key: "dry_fruit_products", kind: "product_carousel", title: "Pantry favorites", tab: "Grocery", sortOrder: 150, categoryIds: pickCategories(["Pantry", "Canned Goods"]), maxItems: 8, config: { categoryIds: pickCategories(["Pantry", "Canned Goods"]), title: "Pantry favorites", maxItems: 8, showSeeAll: true } },
      { key: "instant_food_products", kind: "product_carousel", title: "Instant food", tab: "Grocery", sortOrder: 160, categoryIds: pickCategories(["Instant Noodles"]), maxItems: 8, config: { categoryId: categoryByName.get("Instant Noodles"), title: "Instant food", maxItems: 8, showSeeAll: true } },
      { key: "beauty_products", kind: "product_carousel", title: "Beauty essentials", tab: "Beauty", sortOrder: 170, categoryIds: pickCategories(["Personal Care"]), brandIds: brandByName.get("Colgate") ? [brandByName.get("Colgate") as any] : undefined, maxItems: 8, config: { categoryId: categoryByName.get("Personal Care"), title: "Beauty essentials", maxItems: 8, showSeeAll: true } },
      { key: "store_inventory_summary", kind: "store_inventory_section", title: "Store stock", tab: "All", sortOrder: 180, storeIds: activeStores as any, allowEmpty: true, config: { storeIds: activeStores, showInventorySummary: true, showAvailability: true, statusFilter: "available", maxItems: 8 } },
    ];

    let inserted = 0;
    for (const def of defs) {
      const existing = await ctx.db
        .query("home_sections")
        .withIndex("by_key", (q: any) => q.eq("key", def.key))
        .first();
      if (existing && !args.replaceExisting) continue;
      const section = mergeSection(null, {
        ...def,
        isActive: true,
        allowEmpty: def.allowEmpty ?? false,
        timezone: "Asia/Manila",
        createdAt: t,
        updatedAt: t,
      } as Partial<HomeSectionDoc>);
      await validateSection(ctx, section, existing?._id);
      if (existing) {
        await ctx.db.patch(existing._id, cleanPatch(section as any));
      } else {
        const id = await ctx.db.insert("home_sections", cleanPatch(section as any) as any);
        await ctx.db.patch(id, { id, updatedAt: now() });
        inserted += 1;
      }
    }
    return {
      inserted,
      totalDefaults: defs.length,
    };
  },
});

// Legacy aliases kept for older admin builds.
export const create = mutation({
  args: {
    title: v.string(),
    kind: homeSectionKind,
    tab: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const key = args.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const t = now();
    const section = mergeSection(null, {
      key,
      title: args.title,
      kind: args.kind,
      tab: args.tab ?? "All",
      sortOrder: args.sort_order ?? 0,
      isActive: args.is_active ?? true,
      allowEmpty: false,
      timezone: "Asia/Manila",
      createdAt: t,
      updatedAt: t,
    } as Partial<HomeSectionDoc>);
    await validateSection(ctx, section);
    const id = await ctx.db.insert("home_sections", cleanPatch(section as any) as any);
    await ctx.db.patch(id, { id, sort_order: section.sortOrder, is_active: section.isActive });
    return id;
  },
});
export const update = mutation({
  args: {
    id: v.id("home_sections"),
    title: v.optional(v.string()),
    kind: v.optional(homeSectionKind),
    tab: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, sort_order, is_active, ...rest } = args;
    return await updateSectionDocument(
      ctx,
      id,
      cleanPatch({
        ...rest,
        sortOrder: sort_order,
        sort_order,
        isActive: is_active,
        is_active,
      }) as Partial<HomeSectionDoc>,
    );
  },
});
export const remove = archiveSection;
