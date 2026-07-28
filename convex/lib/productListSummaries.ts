import { money } from "../helpers";
import type { InventoryDoc, PriceDoc, SkuDoc } from "../model";

/**
 * Product list summary invariants:
 * - `sku_count` counts every SKU of the product (exact, never truncated).
 * - `total_stock` sums quantity_available/availableQuantity over every
 *   inventory row of the product (exact, never truncated).
 * - `default_sku_id` is the SKU flagged `is_default`, else the lowest
 *   `sort_order` SKU.
 * - `default_price` is the sale_price of the currently active BASE
 *   (store_id === undefined) price for the default SKU; when no base price is
 *   active, the single active store-specific price is used, and only when
 *   exactly one store price is active (ambiguous multi-store prices resolve
 *   to undefined rather than an arbitrary store).
 *
 * Reconciliation scans the full child sets for one product in a single
 * mutation; MAX_PRODUCT_CHILDREN_FOR_RECONCILE is a documented hard cap that
 * is validated (never silently truncated). Incremental writers keep summaries
 * exact by patching only the touched product.
 */
export const PRODUCT_LIST_SUMMARY_VERSION = 2;
export const MAX_PRODUCT_CHILDREN_FOR_RECONCILE = 5_000;

/**
 * How far into the future pricesActive materializes scheduled activations.
 * prices.scheduleTransition (cron) rolls the window forward daily.
 */
export const PRICE_ACTIVE_LOOKAHEAD_MS = 48 * 60 * 60 * 1000;

export interface ActivePriceRow {
  price_id: string;
  store_id?: string;
  sale_price: number;
  starts_at: number;
  ends_at?: number;
}

/**
 * Deterministic precedence: an active base price wins; otherwise exactly one
 * active store price wins; zero or 2+ active store prices -> undefined.
 * Ties are broken by latest starts_at, then document id for stability.
 */
export function activePrice(prices: PriceDoc[], t: number) {
  const active = prices.filter(
    (price) => price.starts_at <= t && (!price.ends_at || price.ends_at > t),
  );
  active.sort(
    (a, b) => b.starts_at - a.starts_at || String(a._id).localeCompare(String(b._id)),
  );
  const base = active.find((price) => !price.store_id);
  if (base) return base;
  const stores = new Set(active.map((price) => price.store_id));
  return stores.size === 1 ? active[0] : undefined;
}

function activePriceFromRows(rows: ActivePriceRow[], t: number) {
  const active = rows.filter(
    (row) => row.starts_at <= t && (!row.ends_at || row.ends_at > t),
  );
  active.sort(
    (a, b) => b.starts_at - a.starts_at || a.price_id.localeCompare(b.price_id),
  );
  const base = active.find((row) => !row.store_id);
  if (base) return base;
  const stores = new Set(active.map((row) => row.store_id));
  return stores.size === 1 ? active[0] : undefined;
}

/** True when a price should be materialized in pricesActive at time `t`. */
export function priceIsActiveMaterializable(
  price: { starts_at: number; ends_at?: number },
  t: number,
) {
  return (
    price.starts_at <= t + PRICE_ACTIVE_LOOKAHEAD_MS &&
    (!price.ends_at || price.ends_at > t)
  );
}

/**
 * Exact active price for one SKU. Primary source is the pricesActive mirror,
 * read with the same documented cardinality ceiling as every other mirror
 * consumer (take of CAP + 1, explicit rejection when a SKU exceeds it —
 * never an unbounded collect); when no mirror rows exist yet (legacy rows
 * written before the mirror/journal rollout, or seeds), fall back to the
 * authoritative prices table via the bounded indexed by_sku read. Both reads
 * are bounded; an over-cap price history is rejected explicitly, never
 * silently truncated.
 */
export async function activePriceForSku(
  ctx: { db: any },
  skuId: string,
  t: number,
): Promise<{ sale_price: number } | undefined> {
  const rows = (await ctx.db
    .query("pricesActive")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", skuId))
    .take(MAX_ACTIVE_MIRROR_ROWS_PER_SKU + 1)) as ActivePriceRow[];
  if (rows.length > MAX_ACTIVE_MIRROR_ROWS_PER_SKU) {
    throw new Error(
      `SKU ${skuId} has more than ${MAX_ACTIVE_MIRROR_ROWS_PER_SKU} active price mirror rows`,
    );
  }
  if (rows.length > 0) return activePriceFromRows(rows, t);
  const prices = (await ctx.db
    .query("prices")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", skuId))
    .take(MAX_ACTIVE_MIRROR_ROWS_PER_SKU + 1)) as PriceDoc[];
  if (prices.length > MAX_ACTIVE_MIRROR_ROWS_PER_SKU) {
    throw new Error(
      `SKU ${skuId} has more than ${MAX_ACTIVE_MIRROR_ROWS_PER_SKU} prices; reconcile with a dedicated workflow`,
    );
  }
  if (prices.length === 0) return undefined;
  const winner = activePrice(prices, t);
  return winner ? { sale_price: winner.sale_price } : undefined;
}

function inventoryQuantity(row: InventoryDoc) {
  return row.quantity_available ?? row.availableQuantity ?? 0;
}

/**
 * Exact summary over all SKUs and inventory rows of a product. Throws when a
 * product exceeds the documented reconciliation cap instead of silently
 * truncating.
 */
export async function computeProductListSummary(
  ctx: { db: any },
  productId: string,
) {
  const product = await ctx.db.get(productId);
  if (!product) return null;
  const [skus, inventory] = (await Promise.all([
    ctx.db
      .query("skus")
      .withIndex("by_product", (q: any) => q.eq("product_id", productId))
      .take(MAX_PRODUCT_CHILDREN_FOR_RECONCILE + 1),
    ctx.db
      .query("inventory")
      .withIndex("by_product_id", (q: any) => q.eq("productId", productId))
      .take(MAX_PRODUCT_CHILDREN_FOR_RECONCILE + 1),
  ])) as [SkuDoc[], InventoryDoc[]];
  if (skus.length > MAX_PRODUCT_CHILDREN_FOR_RECONCILE) {
    throw new Error(
      `Product ${productId} has more than ${MAX_PRODUCT_CHILDREN_FOR_RECONCILE} SKUs; reconcile with a dedicated workflow`,
    );
  }
  if (inventory.length > MAX_PRODUCT_CHILDREN_FOR_RECONCILE) {
    throw new Error(
      `Product ${productId} has more than ${MAX_PRODUCT_CHILDREN_FOR_RECONCILE} inventory rows; reconcile with a dedicated workflow`,
    );
  }
  skus.sort((a, b) => a.sort_order - b.sort_order);
  const defaultSku = skus.find((sku) => sku.is_default) ?? skus[0];
  const totalStock = inventory.reduce(
    (sum, row) => sum + inventoryQuantity(row),
    0,
  );
  const defaultPrice = defaultSku
    ? (await activePriceForSku(ctx, defaultSku._id, Date.now()))?.sale_price
    : undefined;
  const patch = {
    sku_count: skus.length,
    default_sku_id: defaultSku?._id,
    default_price: defaultPrice === undefined ? undefined : money(defaultPrice),
    total_stock: totalStock,
    productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
  };
  return patch;
}

export async function recomputeProductListSummary(
  ctx: { db: any },
  productId: string,
) {
  const patch = await computeProductListSummary(ctx, productId);
  if (!patch) return null;
  const current = (await ctx.db.get(productId)) as {
    sku_count?: number;
    default_sku_id?: string;
    default_price?: number;
    total_stock?: number;
    productListSummaryVersion?: number;
  } | null;
  if (!current) return null;
  // Skip the write when nothing changed: transition drains and cascades call
  // this on every touched product, and unchanged-record rewrites would
  // amplify into pointless reactive invalidations.
  if (
    current.sku_count === patch.sku_count &&
    current.default_sku_id === patch.default_sku_id &&
    current.default_price === patch.default_price &&
    current.total_stock === patch.total_stock &&
    current.productListSummaryVersion === patch.productListSummaryVersion
  ) {
    return patch;
  }
  await ctx.db.patch(productId, patch);
  return patch;
}

const MAX_ACTIVE_MIRROR_ROWS_PER_SKU = 1_000;

/**
 * Delete every pricesActive mirror row for one SKU. Must run whenever prices
 * are deleted outside prices.remove (batched cascades) so stale mirrors can
 * never contribute to default_price.
 */
export async function deletePricesActiveForSku(ctx: { db: any }, skuId: string) {
  const rows = await ctx.db
    .query("pricesActive")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", skuId))
    .take(MAX_ACTIVE_MIRROR_ROWS_PER_SKU + 1);
  if (rows.length > MAX_ACTIVE_MIRROR_ROWS_PER_SKU) {
    throw new Error(
      `SKU ${skuId} has more than ${MAX_ACTIVE_MIRROR_ROWS_PER_SKU} active price mirror rows`,
    );
  }
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

/**
 * Incrementally adjust total_stock when inventory rows are deleted by a
 * batched cascade (store deletion). Each batch applies the exact delta of
 * the rows it deleted transactionally, so retries cannot double-apply.
 */
export async function decrementProductStock(
  ctx: { db: any },
  productId: string,
  quantity: number,
) {
  if (quantity === 0) return;
  const product = await ctx.db.get(productId);
  if (!product) return;
  await ctx.db.patch(productId, {
    total_stock: Math.max(((product as { total_stock?: number }).total_stock ?? 0) - quantity, 0),
    productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
  });
}

/**
 * Refresh only default_price for a product (used by batched cascades that
 * delete prices without touching SKUs). One bounded mirror read per product.
 */
export async function refreshProductDefaultPrice(
  ctx: { db: any },
  productId: string,
) {
  const product = (await ctx.db.get(productId)) as
    | { default_sku_id?: string; default_price?: number }
    | null;
  if (!product) return;
  const next = product.default_sku_id
    ? (await activePriceForSku(ctx, product.default_sku_id, Date.now()))
        ?.sale_price
    : undefined;
  const nextPrice = next === undefined ? undefined : money(next);
  if (product.default_price !== nextPrice) {
    await ctx.db.patch(productId, {
      default_price: nextPrice,
      productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
    });
  }
}
