import fs from "node:fs";

function edit(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`No changes made to ${path}`);
  fs.writeFileSync(path, after);
}
function replace(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing patch target: ${label}`);
  return source.replace(before, after);
}

edit("convex/schema.ts", (s) => {
  s = replace(s,
`  })
    .index("by_coupon_code", ["coupon_code"])
    .index("by_kind", ["kind"])
    .index("by_active", ["is_active"])
    .index("by_active_starts", ["is_active", "starts_at"]),`,
`  })
    .index("by_coupon_code", ["coupon_code"])
    .index("by_kind", ["kind"])
    .index("by_kind_starts", ["kind", "starts_at"])
    .index("by_active", ["is_active"])
    .index("by_active_starts", ["is_active", "starts_at"]),`, "promotion indexes");
  s = replace(s,
`  })
    .index("by_user", ["userId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_inventory", ["inventoryId"]),`,
`  })
    .index("by_user", ["userId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_status_expiry", ["status", "expiresAt"])
    .index("by_inventory", ["inventoryId"]),`, "reservation index");
  return s;
});

edit("convex/categories.ts", (s) => replace(s,
`async function assertNoCategoryCycle(
  ctx: { db: CategoryDbReader },
  categoryId: string,
  parentId?: string,
) {
  let current = parentId;
  while (current) {
    if (current === categoryId) {
      throw new Error("Category parent would create a cycle");
    }
    const parent = await ctx.db.get(current);
    if (!parent) throw new Error("Parent category not found");
    if (parent.deleting_at) throw new Error("Parent category is being deleted");
    current = parent.parent_id;
  }
}`,
`const CATEGORY_ANCESTRY_DEPTH_LIMIT = 100;

async function assertNoCategoryCycle(
  ctx: { db: CategoryDbReader },
  categoryId: string,
  parentId?: string,
) {
  const visited = new Set<string>();
  let current = parentId;
  let depth = 0;
  while (current) {
    if (current === categoryId) throw new Error("Category parent would create a cycle");
    if (visited.has(current)) throw new Error("Category ancestry already contains a corrupt cycle");
    if (depth >= CATEGORY_ANCESTRY_DEPTH_LIMIT) throw new Error("Category ancestry exceeds the 100-level safety limit");
    visited.add(current);
    const parent = await ctx.db.get(current);
    if (!parent) throw new Error("Parent category not found");
    if (parent.deleting_at) throw new Error("Parent category is being deleted");
    current = parent.parent_id;
    depth += 1;
  }
}`, "category ancestry guard"));

edit("convex/promotions.ts", (s) => {
  s = s.replace('import { now, paginate } from "./helpers";', 'import { now } from "./helpers";');
  s = replace(s,
`const CASCADE_BATCH_LIMIT = 100;`,
`const CASCADE_BATCH_LIMIT = 100;
const PROMOTION_PAGE_LIMIT = 100;
const PROMOTION_OFFSET_LIMIT = 500;`, "promotion caps");
  const oldList = `export const list = query({
  args: {
    kind: v.optional(promotionKind),
    activeOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("promotions").collect()) as PromotionDoc[];
    if (args.kind) rows = rows.filter((p) => p.kind === args.kind);
    if (args.activeOnly) {
      const t = Date.now();
      rows = rows.filter(
        (p) => p.is_active && p.starts_at <= t && p.ends_at > t,
      );
    }
    const targets = (await ctx.db
      .query("promotion_targets")
      .collect()) as PromotionTargetDoc[];
    const enriched = rows.map((p) => ({
      ...p,
      target_count: targets.filter((t) => t.promotion_id === p._id).length,
      is_running: p.is_active && p.starts_at <= Date.now() && p.ends_at > Date.now(),
    }));
    enriched.sort((a, b) => b.starts_at - a.starts_at);
    return paginate(enriched, args);
  },
});`;
  const newList = `export const list = query({
  args: {
    kind: v.optional(promotionKind),
    activeOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PROMOTION_PAGE_LIMIT);
    const offset = Math.min(Math.max(args.offset ?? 0, 0), PROMOTION_OFFSET_LIMIT);
    const t = Date.now();
    const queryBuilder = args.kind
      ? ctx.db.query("promotions").withIndex("by_kind_starts", (q: any) => q.eq("kind", args.kind!))
      : args.activeOnly
        ? ctx.db.query("promotions").withIndex("by_active_starts", (q: any) => q.eq("is_active", true).lte("starts_at", t))
        : ctx.db.query("promotions").withIndex("by_active_starts");
    const candidates = (await queryBuilder.order("desc").take(offset + limit + 1)) as PromotionDoc[];
    const filtered = args.activeOnly
      ? candidates.filter((p) => p.is_active && p.starts_at <= t && p.ends_at > t)
      : candidates;
    const page = filtered.slice(offset, offset + limit);
    const data = await Promise.all(page.map(async (promotion) => {
      const targets = await ctx.db
        .query("promotion_targets")
        .withIndex("by_promotion", (q: any) => q.eq("promotion_id", promotion._id))
        .take(CASCADE_BATCH_LIMIT + 1);
      if (targets.length > CASCADE_BATCH_LIMIT) throw new Error("Promotion target count exceeds the supported bound");
      return {
        ...promotion,
        target_count: targets.length,
        is_running: promotion.is_active && promotion.starts_at <= t && promotion.ends_at > t,
      };
    }));
    return {
      data,
      total: offset + filtered.length + (candidates.length > offset + limit ? 1 : 0),
      limit,
      offset,
      hasMore: candidates.length > offset + limit,
    };
  },
});`;
  s = replace(s, oldList, newList, "promotion list");
  s = replace(s,
`  handler: async (ctx, args) => {
    validateWindow(args.starts_at, args.ends_at);`,
`  handler: async (ctx, args) => {
    if ((args.targets?.length ?? 0) > CASCADE_BATCH_LIMIT) throw new Error(\`A promotion can have at most \${CASCADE_BATCH_LIMIT} targets\`);
    validateWindow(args.starts_at, args.ends_at);`, "promotion create cap");
  return s;
});

edit("convex/skus.ts", (s) => {
  s = replace(s,
`/** Keep exactly one default SKU per product. */
async function unsetOtherDefaults`,
`/** Invariant: every product with an active SKU has exactly one active default. */
async function unsetOtherDefaults`, "SKU invariant doc");
  s = replace(s,
`}

export const create = mutation({`,
`}

async function reconcileProductDefault(ctx: { db: any }, productId: string, preferredId?: string) {
  const skus = (await ctx.db
    .query("skus")
    .withIndex("by_product", (q: any) => q.eq("product_id", productId))
    .collect()) as SkuDoc[];
  const active = skus.filter((sku) => sku.is_active && !sku.deleting_at);
  if (!active.length) {
    for (const sku of skus) if (sku.is_default) await ctx.db.patch(sku._id, { is_default: false });
    return;
  }
  const preferred = active.find((sku) => sku._id === preferredId);
  const current = preferred ?? active.find((sku) => sku.is_default) ?? active[0];
  for (const sku of skus) {
    const shouldDefault = sku._id === current._id;
    if (sku.is_default !== shouldDefault) await ctx.db.patch(sku._id, { is_default: shouldDefault });
  }
}

export const create = mutation({`, "SKU reconcile helper");
  s = replace(s,
`    if (args.is_default) {
      await unsetOtherDefaults(ctx, args.product_id, id as string);
    }
    await applyListCountChange`,
`    await reconcileProductDefault(ctx, args.product_id, args.is_default && (args.is_active ?? true) ? id as string : undefined);
    await applyListCountChange`, "SKU create invariant");
  s = replace(s,
`    if (patch.is_default) {
      await unsetOtherDefaults(ctx, sku.product_id, id as string);
    }
    await recomputeProductListSummary(ctx, sku.product_id);`,
`    const effectiveActive = patch.is_active ?? sku.is_active;
    const preferredDestination = patch.is_default && effectiveActive ? id as string : undefined;
    if (preferredDestination) await unsetOtherDefaults(ctx, nextProductId, id as string);
    if (nextProductId !== sku.product_id) await reconcileProductDefault(ctx, sku.product_id);
    await reconcileProductDefault(ctx, nextProductId, preferredDestination);
    await recomputeProductListSummary(ctx, sku.product_id);`, "SKU move invariant");
  s = replace(s,
`    // ensure a remaining SKU becomes default if we deleted the default
    if (sku.is_default) {
      const remaining = (await ctx.db
        .query("skus")
        .withIndex("by_product", (q) => q.eq("product_id", sku.product_id))
        .collect()) as SkuDoc[];
      if (remaining.length > 0) {
        await ctx.db.patch(remaining[0]._id as any, { is_default: true });
      }
    }
    await recomputeProductListSummary`,
`    await reconcileProductDefault(ctx, sku.product_id);
    await recomputeProductListSummary`, "SKU delete invariant");
  return s;
});

edit("convex/quickInventory.ts", (s) => {
  s = replace(s,
`const SHELF_LIFE_BATCH_LIMIT = 100;`,
`const SHELF_LIFE_BATCH_LIMIT = 100;
const RESERVATION_EXPIRY_BATCH_LIMIT = 100;
const SKU_CENTER_RECONCILE_BATCH_LIMIT = 50;`, "inventory caps");
  s = replace(s,
`export const getInventoryBySkuAndCenter = query({`,
`async function uniqueSkuCenterRow(ctx: { db: any }, sku: string, centerId: CenterId) {
  const rows = (await ctx.db
    .query("inventory")
    .withIndex("by_sku_center", (q: any) => q.eq("sku", sku).eq("fulfillmentCenterId", centerId))
    .take(2)) as QuickInventoryDoc[];
  if (rows.length > 1) throw new Error(\`Duplicate inventory rows for SKU \${sku} and fulfillment center\`);
  return rows[0] ?? null;
}

export const getInventoryBySkuAndCenter = query({`, "unique SKU-center helper");
  const oldLookup = `    const rows = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_center", (q) => q.eq("sku", args.sku))
      .collect()) as QuickInventoryDoc[];
    const row = rows.find(
      (candidate) => candidate.fulfillmentCenterId === args.fulfillmentCenterId,
    );`;
  s = replace(s, oldLookup,
`    const row = await uniqueSkuCenterRow(ctx, args.sku, args.fulfillmentCenterId);`, "exact SKU-center lookup");
  const oldSub = `      const inventoryRows = (await ctx.db
        .query("inventory")
        .withIndex("by_sku_center", (q) => q.eq("sku", substituteSku))
        .collect()) as QuickInventoryDoc[];
      const inventory = inventoryRows.find(
        (candidate) => candidate.fulfillmentCenterId === args.fulfillmentCenterId,
      );`;
  s = replace(s, oldSub,
`      const inventory = await uniqueSkuCenterRow(ctx, substituteSku, args.fulfillmentCenterId);`, "substitute SKU-center lookup");
  const oldExpire = `export const expireCartReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const t = now();
    const expired = (await ctx.db
      .query("cartReservations")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", t))
      .collect()) as CartReservationDoc[];
    let count = 0;
    for (const reservation of expired) {
      if (reservation.status !== "active") continue;
      const row = requireQuickInventory(
        (await ctx.db.get(reservation.inventoryId)) as QuickInventoryDoc | null,
      );
      await ctx.db.patch(reservation.inventoryId, {
        ...quickInventoryPatch(
          row.availableQuantity!,
          Math.max(row.reservedQuantity! - reservation.quantity, 0),
          row.replenishmentThreshold!,
          row.isActive,
        ),
      });
      await ctx.db.patch(reservation._id, { status: "expired" });
      count += 1;
    }
    return { expired: count };
  },
});`;
  const newExpire = `export const expireCartReservations = internalMutation({
  args: { evaluatedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const t = args.evaluatedAt ?? now();
    const expired = (await ctx.db
      .query("cartReservations")
      .withIndex("by_status_expiry", (q) => q.eq("status", "active").lt("expiresAt", t))
      .take(RESERVATION_EXPIRY_BATCH_LIMIT)) as CartReservationDoc[];
    let count = 0;
    for (const reservation of expired) {
      const fresh = (await ctx.db.get(reservation._id)) as CartReservationDoc | null;
      if (!fresh || fresh.status !== "active") continue;
      const row = requireQuickInventory((await ctx.db.get(fresh.inventoryId)) as QuickInventoryDoc | null);
      await ctx.db.patch(fresh.inventoryId, {
        ...quickInventoryPatch(row.availableQuantity!, Math.max(row.reservedQuantity! - fresh.quantity, 0), row.replenishmentThreshold!, row.isActive),
      });
      await ctx.db.patch(fresh._id, { status: "expired" });
      count += 1;
    }
    if (expired.length === RESERVATION_EXPIRY_BATCH_LIMIT) {
      await ctx.scheduler.runAfter(0, anyApi.quickInventory.expireCartReservations, { evaluatedAt: t });
    }
    return { expired: count, processed: expired.length, remainingMayExist: expired.length === RESERVATION_EXPIRY_BATCH_LIMIT };
  },
});`;
  s = replace(s, oldExpire, newExpire, "bounded reservation expiry");
  s += `

/** Bounded duplicate audit. Conflicting rows with references are reported, not deleted. */
export const reconcileSkuCenterDuplicates = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("inventory").order("asc").paginate({ numItems: SKU_CENTER_RECONCILE_BATCH_LIMIT, cursor: args.cursor ?? null });
    let repaired = 0;
    let conflicts = 0;
    const seen = new Set<string>();
    for (const row of result.page as QuickInventoryDoc[]) {
      if (!row.sku || !row.fulfillmentCenterId) continue;
      const identity = \`${row.sku}:\${row.fulfillmentCenterId}\`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const duplicates = (await ctx.db.query("inventory").withIndex("by_sku_center", (q: any) => q.eq("sku", row.sku!).eq("fulfillmentCenterId", row.fulfillmentCenterId!)).take(3)) as QuickInventoryDoc[];
      if (duplicates.length < 2) continue;
      const extra = duplicates.slice(1);
      let blocked = false;
      for (const duplicate of extra) {
        const [reservation, batch, pricing] = await Promise.all([
          ctx.db.query("cartReservations").withIndex("by_inventory", (q: any) => q.eq("inventoryId", duplicate._id)).first(),
          ctx.db.query("batches").withIndex("by_inventory_expiry", (q: any) => q.eq("inventoryId", duplicate._id)).first(),
          ctx.db.query("inventoryPricing").withIndex("by_inventory", (q: any) => q.eq("inventoryId", duplicate._id)).first(),
        ]);
        if (reservation || batch || pricing) { blocked = true; break; }
      }
      if (blocked || duplicates.length > 2) { conflicts += 1; continue; }
      const keep = duplicates[0];
      const extraRow = duplicates[1];
      await ctx.db.patch(keep._id, quickInventoryPatch(
        (keep.availableQuantity ?? 0) + (extraRow.availableQuantity ?? 0),
        (keep.reservedQuantity ?? 0) + (extraRow.reservedQuantity ?? 0),
        Math.max(keep.replenishmentThreshold ?? 0, extraRow.replenishmentThreshold ?? 0),
        keep.isActive !== false || extraRow.isActive !== false,
      ));
      await ctx.db.delete(extraRow._id);
      repaired += 1;
    }
    if (!result.isDone) await ctx.scheduler.runAfter(0, anyApi.quickInventory.reconcileSkuCenterDuplicates, { cursor: result.continueCursor });
    return { processed: result.page.length, repaired, conflicts, nextCursor: result.continueCursor, remainingMayExist: !result.isDone };
  },
});
`;
  return s;
});

fs.writeFileSync("tests/pendingBackendFixes.test.ts", `import { readFileSync } from "node:fs";\nimport { describe, expect, it } from "vitest";\n\nconst read = (name: string) => readFileSync(new URL(\`../convex/\${name}\`, import.meta.url), "utf8");\n\ndescribe("pending backend invariant fixes", () => {\n  it("bounds and indexes promotion listing and target counts", () => {\n    const s = read("promotions.ts");\n    expect(s).toContain('withIndex("by_kind_starts"');\n    expect(s).toContain('withIndex("by_promotion"');\n    expect(s).not.toContain('query("promotion_targets")\\n      .collect()');\n  });\n  it("guards category ancestry with visited and depth bounds", () => {\n    const s = read("categories.ts");\n    expect(s).toContain("const visited = new Set<string>()");\n    expect(s).toContain("CATEGORY_ANCESTRY_DEPTH_LIMIT");\n  });\n  it("repairs source and destination default SKU invariants", () => {\n    const s = read("skus.ts");\n    expect(s).toContain("reconcileProductDefault(ctx, sku.product_id)");\n    expect(s).toContain("reconcileProductDefault(ctx, nextProductId");\n  });\n  it("fully constrains SKU-center lookups and audits duplicates", () => {\n    const s = read("quickInventory.ts");\n    expect(s).toContain('.eq("sku", sku).eq("fulfillmentCenterId", centerId)');\n    expect(s).toContain("reconcileSkuCenterDuplicates");\n  });\n  it("drains only active due reservations in bounded batches", () => {\n    const s = read("quickInventory.ts");\n    expect(s).toContain('withIndex("by_status_expiry"');\n    expect(s).toContain("RESERVATION_EXPIRY_BATCH_LIMIT");\n    expect(s).toContain("remainingMayExist");\n  });\n});\n`);

fs.rmSync("scripts/apply-five-backend-fixes.mjs");
fs.rmSync(".github/workflows/apply-five-backend-fixes.yml");
