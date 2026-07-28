import { v } from "convex/values";
import { query } from "./functions";
import type {
  CustomerDoc,
  InventoryDoc,
  OrderDoc,
  ProductDoc,
  PromotionDoc,
  SkuDoc,
  SupportTicketDoc,
} from "./model";
import type { DashboardStats } from "./model";

interface IndexRangeBuilder {
  eq(fieldName: string, value: unknown): IndexRangeBuilder;
}

interface QueryBuilder<T> {
  withIndex(
    indexName: string,
    indexRange?: (q: IndexRangeBuilder) => IndexRangeBuilder,
  ): QueryBuilder<T>;
  take(n: number): Promise<T[]>;
}

interface DbReader {
  get(id: string): Promise<unknown | null>;
  query<T = unknown>(tableName: string): QueryBuilder<T>;
}

function alertLimit(limit?: number) {
  return Math.min(Math.max(limit ?? 12, 1), 100);
}

async function fetchById<T>(
  ctx: { db: DbReader },
  ids: string[],
): Promise<Map<string, T | null>> {
  const out = new Map<string, T | null>();
  await Promise.all(
    Array.from(new Set(ids)).map(async (id) => {
      out.set(id, (await ctx.db.get(id)) as T | null);
    }),
  );
  return out;
}

export const stats = query({
  args: {},
  handler: async (ctx): Promise<DashboardStats> => {
    const [products, skus, orders, inventory, customers, tickets, promotions] =
      (await Promise.all([
        ctx.db.query("products").collect(),
        ctx.db.query("skus").collect(),
        ctx.db.query("orders").collect(),
        ctx.db.query("inventory").collect(),
        ctx.db.query("customers").collect(),
        ctx.db.query("support_tickets").collect(),
        ctx.db.query("promotions").collect(),
      ])) as [
        ProductDoc[],
        SkuDoc[],
        OrderDoc[],
        InventoryDoc[],
        CustomerDoc[],
        SupportTicketDoc[],
        PromotionDoc[],
      ];

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const startMs = dayStart.getTime();
    const validOrders = orders.filter(
      (o) => o.status !== "cancelled" && o.status !== "refunded",
    );
    const t = Date.now();

    return {
      total_products: products.length,
      active_products: products.filter((p) => p.status === "active").length,
      total_skus: skus.length,
      total_orders: orders.length,
      orders_today: orders.filter((o) => o.placed_at >= startMs).length,
      revenue_total:
        Math.round(
          validOrders.reduce((s, o) => s + o.total_amount, 0) * 100,
        ) / 100,
      revenue_today:
        Math.round(
          validOrders
            .filter((o) => o.placed_at >= startMs)
            .reduce((s, o) => s + o.total_amount, 0) * 100,
        ) / 100,
      low_stock_count: inventory.filter((i) => i.status === "low_stock").length,
      out_of_stock_count: inventory.filter((i) => i.status === "out_of_stock")
        .length,
      total_customers: customers.length,
      open_tickets: tickets.filter((x) => x.status === "open").length,
      active_promotions: promotions.filter(
        (p) => p.is_active && p.starts_at <= t && p.ends_at > t,
      ).length,
    };
  },
});

export const recentOrders = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const orders = (await ctx.db.query("orders").collect()) as OrderDoc[];
    orders.sort((a, b) => b.placed_at - a.placed_at);
    const customers = new Map(
      ((await ctx.db.query("customers").collect()) as CustomerDoc[]).map((c) => [
        c._id,
        c,
      ]),
    );
    const stores = new Map(
      (await ctx.db.query("stores").collect()).map((s) => [
        s._id as string,
        s.name as string,
      ]),
    );
    return orders.slice(0, args.limit ?? 8).map((o) => ({
      ...o,
      customer_name:
        customers.get(o.customer_id)?.display_name ??
        `${customers.get(o.customer_id)?.phone_country_code ?? ""}${customers.get(o.customer_id)?.phone_number ?? ""}`,
      store_name: stores.get(o.store_id),
    }));
  },
});

export async function lowStockAlertsHandler(
  ctx: { db: DbReader },
  args: { limit?: number },
) {
  const limit = alertLimit(args.limit);
  const [lowStock, outOfStock] = await Promise.all([
    ctx.db
      .query<InventoryDoc>("inventory")
      .withIndex("by_status_quantity", (q) =>
        q.eq("status", "low_stock"),
      )
      .take(limit),
    ctx.db
      .query<InventoryDoc>("inventory")
      .withIndex("by_status_quantity", (q) =>
        q.eq("status", "out_of_stock"),
      )
      .take(limit),
  ]);
  const candidates = ([...lowStock, ...outOfStock] as InventoryDoc[])
    .filter((i) => i.sku_id !== undefined && i.store_id !== undefined)
    .sort((a, b) => a.quantity_available - b.quantity_available)
    .slice(0, limit);

  const skuCache = await fetchById<SkuDoc>(
    ctx,
    candidates.map((row) => row.sku_id),
  );
  const productCache = await fetchById<ProductDoc>(
    ctx,
    candidates
      .map((row) => skuCache.get(row.sku_id)?.product_id)
      .filter((id): id is string => id !== undefined),
  );
  const storeCache = await fetchById<{ name: string }>(
    ctx,
    candidates.map((row) => row.store_id),
  );

  const out = [];
  for (const row of candidates) {
    const sku = skuCache.get(row.sku_id);
    if (!sku) continue;
    out.push({
      ...row,
      sku_code: sku.sku_code,
      variant_label: sku.variant_label,
      product_name: productCache.get(sku.product_id)?.name ?? "(deleted)",
      store_name: storeCache.get(row.store_id)?.name ?? "(deleted store)",
    });
  }
  return out;
}

export const lowStockAlerts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    lowStockAlertsHandler(ctx as { db: DbReader }, args),
});
