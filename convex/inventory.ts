import { v } from "convex/values";
import { query, mutation } from "./functions";
import { deriveInventoryStatus, now } from "./helpers";
import type {
  InventoryDoc,
  InventoryRow,
  InventoryStatus,
  ProductDoc,
  SkuDoc,
} from "./model";

const inventoryStatus = v.union(
  v.literal("in_stock"),
  v.literal("low_stock"),
  v.literal("out_of_stock"),
  v.literal("unavailable"),
);

interface ListByStoreArgs {
  store_id: string;
  status?: InventoryStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

function isLegacyInventoryRow(row: InventoryDoc): boolean {
  return row.sku_id !== undefined && row.store_id !== undefined;
}

function inventoryPageArgs(args: { limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const offset = Math.max(args.offset ?? 0, 0);
  return { limit, offset };
}

function inventorySearchText(
  row: InventoryDoc,
  sku?: SkuDoc | null,
  product?: ProductDoc | null,
) {
  return `${row.productName ?? product?.name ?? ""} ${row.skuCode ?? sku?.sku_code ?? ""} ${row.variantLabel ?? sku?.variant_label ?? ""}`.toLowerCase();
}

function inventorySortName(
  row: InventoryDoc,
  product?: ProductDoc | null,
) {
  return row.productName ?? product?.name ?? "";
}

async function loadSkuProductLookups(
  ctx: { db: any },
  rows: InventoryDoc[],
) {
  const skuCache = new Map<string, SkuDoc | null>();
  const productCache = new Map<string, ProductDoc | null>();
  for (const row of rows) {
    if (!isLegacyInventoryRow(row)) continue;
    if (!skuCache.has(row.sku_id)) {
      skuCache.set(row.sku_id, (await ctx.db.get(row.sku_id)) as SkuDoc | null);
    }
    const sku = skuCache.get(row.sku_id);
    if (!sku) continue;
    if (!productCache.has(sku.product_id)) {
      productCache.set(
        sku.product_id,
        (await ctx.db.get(sku.product_id)) as ProductDoc | null,
    );
    }
  }
  return { skuCache, productCache };
}

export async function listByStoreHandler(
  ctx: { db: any },
  args: ListByStoreArgs,
) {
  let rows: InventoryDoc[];
  if (args.status) {
    rows = (await ctx.db
      .query("inventory")
      .withIndex("by_store_status", (q: any) =>
        q.eq("store_id", args.store_id).eq("status", args.status!),
      )
      .collect()) as InventoryDoc[];
  } else {
    rows = (await ctx.db
      .query("inventory")
      .withIndex("by_store", (q: any) => q.eq("store_id", args.store_id))
      .collect()) as InventoryDoc[];
  }
  rows = rows.filter(isLegacyInventoryRow);

  const missingSummaryRows = rows.filter(
    (row) =>
      row.productName === undefined ||
      row.skuCode === undefined ||
      row.variantLabel === undefined,
  );
  const { skuCache, productCache } = await loadSkuProductLookups(
    ctx,
    missingSummaryRows,
  );

  if (args.search) {
    const s = args.search.toLowerCase();
    rows = rows.filter((row) => {
      const sku = skuCache.get(row.sku_id);
      const product = sku ? productCache.get(sku.product_id) : null;
      return inventorySearchText(row, sku, product).includes(s);
    });
  }

  rows.sort((a, b) => {
    const aSku = skuCache.get(a.sku_id);
    const bSku = skuCache.get(b.sku_id);
    const aProduct = aSku ? productCache.get(aSku.product_id) : null;
    const bProduct = bSku ? productCache.get(bSku.product_id) : null;
    return inventorySortName(a, aProduct).localeCompare(
      inventorySortName(b, bProduct),
    );
  });

  const { limit, offset } = inventoryPageArgs(args);
  const pageRows = rows.slice(offset, offset + limit);
  const pageMissing = pageRows.filter(
    (row) => !skuCache.has(row.sku_id) || !row.productName,
  );
  const pageLookups = await loadSkuProductLookups(ctx, pageMissing);
  for (const [id, sku] of pageLookups.skuCache) skuCache.set(id, sku);
  for (const [id, product] of pageLookups.productCache) {
    productCache.set(id, product);
  }

  const data: InventoryRow[] = [];
  for (const row of pageRows) {
    const sku = skuCache.get(row.sku_id);
    if (!sku) continue;
    const product = productCache.get(sku.product_id);
    data.push({
      ...row,
      sku_code: sku.sku_code,
      variant_label: sku.variant_label,
      product_name: product?.name ?? "(deleted product)",
      product_id: sku.product_id,
    });
  }
  return { data, total: rows.length, limit, offset };
}

export async function summaryByStoreHandler(
  ctx: { db: any },
  args: { store_id: string },
) {
  const rows = ((await ctx.db
    .query("inventory")
    .withIndex("by_store", (q: any) => q.eq("store_id", args.store_id))
    .collect()) as InventoryDoc[]).filter(isLegacyInventoryRow);
  const summary = {
    total_skus: rows.length,
    in_stock: 0,
    low_stock: 0,
    out_of_stock: 0,
    unavailable: 0,
    total_units: 0,
    reserved_units: 0,
  };
  for (const r of rows) {
    summary[r.status as InventoryStatus] += 1;
    summary.total_units += r.quantity_available;
    summary.reserved_units += r.quantity_reserved;
  }
  return summary;
}

export const listByStore = query({
  args: {
    store_id: v.id("stores"),
    status: v.optional(inventoryStatus),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return listByStoreHandler(ctx, args);
  },
});

export const summaryByStore = query({
  args: { store_id: v.id("stores") },
  handler: async (ctx, args) => {
    return summaryByStoreHandler(ctx, args);
  },
});

/** Create or replace the inventory row for (sku, store). Status auto-derived. */
export const upsert = mutation({
  args: {
    sku_id: v.id("skus"),
    store_id: v.id("stores"),
    quantity_available: v.number(),
    low_stock_threshold: v.optional(v.number()),
    restock_at: v.optional(v.number()),
    unavailable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.quantity_available < 0) {
      throw new Error("quantity_available must be >= 0");
    }
    const existing = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_store", (q: any) =>
        q.eq("sku_id", args.sku_id).eq("store_id", args.store_id),
      )
      .first()) as InventoryDoc | null;
    const threshold =
      args.low_stock_threshold ?? existing?.low_stock_threshold ?? 5;
    const status = deriveInventoryStatus({
      quantityAvailable: args.quantity_available,
      lowStockThreshold: threshold,
      manualUnavailable: args.unavailable ?? existing?.status === "unavailable",
    });
    const sku = (await ctx.db.get(args.sku_id)) as SkuDoc | null;
    const product = sku
      ? ((await ctx.db.get(sku.product_id as any)) as ProductDoc | null)
      : null;
    if (existing) {
      await ctx.db.patch(existing._id as any, {
        quantity_available: args.quantity_available,
        low_stock_threshold: threshold,
        restock_at: args.restock_at,
        status,
        updated_at: now(),
        skuCode: sku?.sku_code,
        variantLabel: sku?.variant_label,
        productName: product?.name,
      });
      return existing._id;
    }
    return await ctx.db.insert("inventory", {
      sku_id: args.sku_id,
      store_id: args.store_id,
      quantity_available: args.quantity_available,
      quantity_reserved: 0,
      low_stock_threshold: threshold,
      status,
      restock_at: args.restock_at,
      updated_at: now(),
      skuCode: sku?.sku_code,
      variantLabel: sku?.variant_label,
      productName: product?.name,
    });
  },
});

/** Adjust available quantity by a delta (positive = restock, negative = write-off). */
export const adjust = mutation({
  args: {
    sku_id: v.id("skus"),
    store_id: v.id("stores"),
    delta: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_store", (q: any) =>
        q.eq("sku_id", args.sku_id).eq("store_id", args.store_id),
      )
      .first()) as InventoryDoc | null;
    if (!existing) throw new Error("No inventory row for this SKU at this store");
    const next = existing.quantity_available + args.delta;
    if (next < 0) {
      throw new Error(
        `Adjustment would make quantity negative (${existing.quantity_available} + ${args.delta})`,
      );
    }
    const status = deriveInventoryStatus({
      quantityAvailable: next,
      lowStockThreshold: existing.low_stock_threshold,
      manualUnavailable: existing.status === "unavailable",
    });
    await ctx.db.patch(existing._id as any, {
      quantity_available: next,
      status,
      updated_at: now(),
    });
    return { quantity_available: next, status };
  },
});

export const setThreshold = mutation({
  args: {
    sku_id: v.id("skus"),
    store_id: v.id("stores"),
    low_stock_threshold: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.low_stock_threshold < 0) throw new Error("Threshold must be >= 0");
    const existing = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_store", (q: any) =>
        q.eq("sku_id", args.sku_id).eq("store_id", args.store_id),
      )
      .first()) as InventoryDoc | null;
    if (!existing) throw new Error("No inventory row for this SKU at this store");
    const status = deriveInventoryStatus({
      quantityAvailable: existing.quantity_available,
      lowStockThreshold: args.low_stock_threshold,
      manualUnavailable: existing.status === "unavailable",
    });
    await ctx.db.patch(existing._id as any, {
      low_stock_threshold: args.low_stock_threshold,
      status,
      updated_at: now(),
    });
  },
});

export const setUnavailable = mutation({
  args: {
    sku_id: v.id("skus"),
    store_id: v.id("stores"),
    unavailable: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = (await ctx.db
      .query("inventory")
      .withIndex("by_sku_store", (q: any) =>
        q.eq("sku_id", args.sku_id).eq("store_id", args.store_id),
      )
      .first()) as InventoryDoc | null;
    if (!existing) throw new Error("No inventory row for this SKU at this store");
    const status = deriveInventoryStatus({
      quantityAvailable: existing.quantity_available,
      lowStockThreshold: existing.low_stock_threshold,
      manualUnavailable: args.unavailable,
    });
    await ctx.db.patch(existing._id as any, { status, updated_at: now() });
  },
});

export const remove = mutation({
  args: { id: v.id("inventory") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
