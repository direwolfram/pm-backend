import { money } from "../helpers";
import type { InventoryDoc, PriceDoc, SkuDoc } from "../model";

export const PRODUCT_LIST_SUMMARY_VERSION = 1;

function activePrice(prices: PriceDoc[], t: number) {
  const active = prices.filter(
    (price) => price.starts_at <= t && (!price.ends_at || price.ends_at > t),
  );
  return active.find((price) => !price.store_id) ?? active[0];
}

export async function recomputeProductListSummary(
  ctx: { db: any },
  productId: string,
) {
  const product = await ctx.db.get(productId);
  if (!product) return null;
  const [skus, prices, inventory] = (await Promise.all([
    ctx.db
      .query("skus")
      .withIndex("by_product", (q: any) => q.eq("product_id", productId))
      .collect(),
    ctx.db
      .query("prices")
      .withIndex("by_product", (q: any) => q.eq("product_id", productId))
      .collect(),
    ctx.db
      .query("inventory")
      .withIndex("by_product_id", (q: any) => q.eq("productId", productId))
      .collect(),
  ])) as [SkuDoc[], PriceDoc[], InventoryDoc[]];
  skus.sort((a, b) => a.sort_order - b.sort_order);
  const defaultSku = skus.find((sku) => sku.is_default) ?? skus[0];
  const totalStock = inventory.reduce(
    (sum, row) => sum + (row.quantity_available ?? row.availableQuantity ?? 0),
    0,
  );
  const defaultPrice = defaultSku
    ? activePrice(
        prices.filter((price) => price.sku_id === defaultSku._id),
        Date.now(),
      )?.sale_price
    : undefined;
  const patch = {
    sku_count: skus.length,
    default_sku_id: defaultSku?._id,
    default_price: defaultPrice === undefined ? undefined : money(defaultPrice),
    total_stock: totalStock,
    productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
  };
  await ctx.db.patch(productId, patch);
  return patch;
}
