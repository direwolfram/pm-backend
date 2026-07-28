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
 * Exact active price for one SKU via the bounded pricesActive mirror
 * (one SKU can only have a handful of concurrent active prices).
 */
export async function activePriceForSku(
  ctx: { db: any },
  skuId: string,
  t: number,
): Promise<{ sale_price: number } | undefined> {
  const rows = (await ctx.db
    .query("pricesActive")
    .withIndex("by_sku", (q: any) => q.eq("sku_id", skuId))
    .collect()) as ActivePriceRow[];
  return activePriceFromRows(rows, t);
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
  await ctx.db.patch(productId, patch);
  return patch;
}
