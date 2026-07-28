import { money } from "../helpers";
import type { InventoryDoc, PriceDoc, SkuDoc } from "../model";

export const PRODUCT_LIST_SUMMARY_VERSION = 1;
const MAX_PRODUCT_SKUS_FOR_SUMMARY = 500;
const MAX_PRODUCT_INVENTORY_FOR_SUMMARY = 1_000;
const MAX_PRICE_CANDIDATES_FOR_ACTIVE_PRICE = 50;

export function activePrice(prices: PriceDoc[], t: number) {
  const active = prices.filter(
    (price) => price.starts_at <= t && (!price.ends_at || price.ends_at > t),
  );
  return active.find((price) => !price.store_id) ?? active[0];
}

export async function activePriceForSku(
  ctx: { db: any },
  skuId: string,
  t: number,
) {
  const prices = (await ctx.db
    .query("prices")
    .withIndex("by_sku_starts", (q: any) =>
      q.eq("sku_id", skuId).lte("starts_at", t),
    )
    .order("desc")
    .take(MAX_PRICE_CANDIDATES_FOR_ACTIVE_PRICE)) as PriceDoc[];
  return activePrice(prices, t);
}

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
      .take(MAX_PRODUCT_SKUS_FOR_SUMMARY),
    ctx.db
      .query("inventory")
      .withIndex("by_product_id", (q: any) => q.eq("productId", productId))
      .take(MAX_PRODUCT_INVENTORY_FOR_SUMMARY),
  ])) as [SkuDoc[], InventoryDoc[]];
  skus.sort((a, b) => a.sort_order - b.sort_order);
  const defaultSku = skus.find((sku) => sku.is_default) ?? skus[0];
  const totalStock = inventory.reduce(
    (sum, row) => sum + (row.quantity_available ?? row.availableQuantity ?? 0),
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
