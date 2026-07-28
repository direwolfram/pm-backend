import { v } from "convex/values";
import { query, mutation, internalMutation } from "./functions";
import { boundedPageArgs, now, pageResponse } from "./helpers";
import { applyOrderStatsChange } from "./lib/customerAggregates";
import type {
  AddressDoc,
  CustomerDoc,
  OrderDoc,
  OrderItemDoc,
  OrderListRow,
  OrderStatus,
  PaymentDoc,
  StoreDoc,
} from "./model";

const orderStatus = v.union(
  v.literal("pending_payment"),
  v.literal("confirmed"),
  v.literal("picking"),
  v.literal("packed"),
  v.literal("out_for_delivery"),
  v.literal("delivered"),
  v.literal("cancelled"),
  v.literal("refunded"),
);
const paymentStatus = v.union(
  v.literal("pending"),
  v.literal("authorized"),
  v.literal("paid"),
  v.literal("failed"),
  v.literal("refunded"),
);

function orderSearchText(order: OrderDoc, customer?: CustomerDoc | null) {
  return [
    order.order_number,
    customer?.display_name ?? "",
    customer?.phone_country_code ?? "",
    customer?.phone_number ?? "",
    customer ? `${customer.phone_country_code}${customer.phone_number}` : "",
  ]
    .join(" ")
    .toLowerCase();
}

function orderIndex(args: {
  status?: OrderStatus;
  store_id?: string;
  placed_from?: number;
  placed_to?: number;
}) {
  if (args.store_id && args.status) return "by_store_status_placed";
  if (args.store_id) return "by_store_placed";
  if (args.status) return "by_status_placed";
  return "by_placed";
}

async function pageOrders(
  ctx: { db: any },
  args: {
    status?: OrderStatus;
    store_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
    placed_from?: number;
    placed_to?: number;
  },
) {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const offset = args.cursor ? 0 : pageArgs.offset;
  const fetchLimit = Math.min(limit + offset + 1, 201);
  const cursorOrder = args.cursor
    ? ((await ctx.db.get(args.cursor as any)) as OrderDoc | null)
    : null;
  let queryBuilder;
  if (args.search?.trim()) {
    queryBuilder = ctx.db.query("orders").withSearchIndex("search_orders", (q: any) => {
      let s = q.search("order_search_text", args.search!.trim().toLowerCase());
      if (args.status) s = s.eq("status", args.status);
      if (args.store_id) s = s.eq("store_id", args.store_id);
      return s;
    });
  } else {
    const indexName = orderIndex(args);
    queryBuilder = ctx.db.query("orders").withIndex(indexName, (q: any) => {
      const withBounds = (range: any) => {
        let out = range;
        if (cursorOrder) {
          const upper =
            args.placed_to !== undefined
              ? Math.min(cursorOrder.placed_at, args.placed_to)
              : cursorOrder.placed_at;
          out =
            args.placed_to !== undefined && args.placed_to < cursorOrder.placed_at
              ? out.lte("placed_at", upper)
              : out.lt("placed_at", upper);
        } else if (args.placed_to !== undefined) {
          out = out.lte("placed_at", args.placed_to);
        }
        if (args.placed_from !== undefined) out = out.gte("placed_at", args.placed_from);
        return out;
      };
      if (args.store_id && args.status) {
        return withBounds(
          q.eq("store_id", args.store_id).eq("status", args.status),
        );
      }
      if (args.store_id) return withBounds(q.eq("store_id", args.store_id));
      if (args.status) return withBounds(q.eq("status", args.status));
      return withBounds(q);
    });
  }
  const rows = ((await queryBuilder.order("desc").take(fetchLimit)) as OrderDoc[])
    .filter(
      (order) =>
        (args.placed_from === undefined || order.placed_at >= args.placed_from) &&
        (args.placed_to === undefined || order.placed_at <= args.placed_to),
    )
    .slice(offset, offset + limit + 1);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

async function enrichOrders(ctx: { db: any }, orders: OrderDoc[]) {
  const [customers, stores, fallbackCounts] = await Promise.all([
    Promise.all(
      Array.from(new Set(orders.map((order) => order.customer_id))).map(
        async (id) => [id, (await ctx.db.get(id as any)) as CustomerDoc | null] as const,
      ),
    ),
    Promise.all(
      Array.from(new Set(orders.map((order) => order.store_id))).map(
        async (id) => [id, (await ctx.db.get(id as any)) as StoreDoc | null] as const,
      ),
    ),
    Promise.all(
      orders
        .filter((order) => order.item_count === undefined)
        .map(async (order) => {
          const items = (await ctx.db
            .query("order_items")
            .withIndex("by_order", (q: any) => q.eq("order_id", order._id))
            .collect()) as OrderItemDoc[];
          return [
            order._id,
            items.reduce((sum, item) => sum + item.quantity, 0),
          ] as const;
        }),
    ),
  ]);
  const customersById = new Map(customers);
  const storesById = new Map(stores);
  const itemCounts = new Map(fallbackCounts);
  return orders.map((o): OrderListRow => {
    const c = customersById.get(o.customer_id);
    return {
      ...o,
      customer_name:
        c?.display_name ?? `${c?.phone_country_code ?? ""}${c?.phone_number ?? ""}`,
      store_name: storesById.get(o.store_id)?.name,
      item_count: o.item_count ?? itemCounts.get(o._id) ?? 0,
    };
  });
}

export async function listHandler(
  ctx: { db: any },
  args: {
    status?: OrderStatus;
    store_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: string;
    placed_from?: number;
    placed_to?: number;
  },
) {
  const { rows, hasMore } = await pageOrders(ctx, args);
  const enriched = await enrichOrders(ctx, rows);
  return pageResponse(enriched, args, hasMore);
}

/** Allowed forward transitions + terminal escape hatches. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["picking", "cancelled"],
  picking: ["packed", "cancelled"],
  packed: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
};

export const list = query({
  args: {
    status: v.optional(orderStatus),
    store_id: v.optional(v.id("stores")),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
    placed_from: v.optional(v.number()),
    placed_to: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await listHandler(ctx, args);
  },
});

export const get = query({
  args: { id: v.id("orders") },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    const items = (await ctx.db
      .query("order_items")
      .withIndex("by_order", (q) => q.eq("order_id", args.id))
      .collect()) as OrderItemDoc[];
    const payment = (await ctx.db
      .query("payments")
      .withIndex("by_order", (q) => q.eq("order_id", args.id))
      .first()) as PaymentDoc | null;
    const customer = (await ctx.db.get(order.customer_id as any)) as CustomerDoc | null;
    const store = (await ctx.db.get(order.store_id as any)) as StoreDoc | null;
    const address = (await ctx.db.get(order.address_id as any)) as AddressDoc | null;
    return {
      ...order,
      items,
      payment,
      customer_name: customer?.display_name,
      customer_phone: customer
        ? `${customer.phone_country_code}${customer.phone_number}`
        : undefined,
      store_name: store?.name,
      address_label: address
        ? `${address.title} — ${address.full_address}`
        : undefined,
    };
  },
});

export const updateStatus = mutation({
  args: { id: v.id("orders"), status: orderStatus },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    if (order.status === args.status) return args.id;
    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(args.status)) {
      throw new Error(
        `Cannot move order from "${order.status}" to "${args.status}". Allowed: ${allowed.join(", ") || "none (terminal state)"}`,
      );
    }
    const patch: Record<string, unknown> = { status: args.status };
    if (args.status === "delivered") patch.delivered_at = now();
    if (args.status === "cancelled") patch.cancelled_at = now();
    await ctx.db.patch(args.id, patch);
    await applyOrderStatsChange(ctx, order, {
      ...order,
      status: args.status,
      delivered_at:
        args.status === "delivered" ? (patch.delivered_at as number) : order.delivered_at,
      cancelled_at:
        args.status === "cancelled" ? (patch.cancelled_at as number) : order.cancelled_at,
    });
    return args.id;
  },
});

export const updatePaymentStatus = mutation({
  args: { id: v.id("orders"), payment_status: paymentStatus },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    await ctx.db.patch(args.id, { payment_status: args.payment_status });
    const payment = (await ctx.db
      .query("payments")
      .withIndex("by_order", (q) => q.eq("order_id", args.id))
      .first()) as PaymentDoc | null;
    if (payment) {
      await ctx.db.patch(payment._id as any, {
        status: args.payment_status,
        paid_at: args.payment_status === "paid" ? now() : payment.paid_at,
        updated_at: now(),
      });
    }
    return args.id;
  },
});

export const backfillOrderListSummaries = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const orders = (await ctx.db
      .query("orders")
      .withIndex("by_order_stats_backfill", (q) => q.eq("item_count", undefined))
      .take(limit)) as OrderDoc[];
    let patched = 0;
    for (const order of orders) {
      const [items, customer] = await Promise.all([
        ctx.db
          .query("order_items")
          .withIndex("by_order", (q: any) => q.eq("order_id", order._id))
          .collect(),
        ctx.db.get(order.customer_id as any),
      ]);
      const itemCount = (items as OrderItemDoc[]).reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      await ctx.db.patch(order._id as any, {
        item_count: itemCount,
        order_search_text: orderSearchText(order, customer as CustomerDoc | null),
      });
      patched += 1;
    }
    return {
      processed: orders.length,
      patched,
      remainingMayExist: orders.length >= limit,
    };
  },
});
