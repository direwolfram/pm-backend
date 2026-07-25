import { v } from "convex/values";
import { query, mutation } from "./functions";
import { now, paginate } from "./helpers";
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
  },
  handler: async (ctx, args) => {
    let rows: OrderDoc[];
    if (args.status) {
      rows = (await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect()) as OrderDoc[];
    } else if (args.store_id) {
      rows = (await ctx.db
        .query("orders")
        .withIndex("by_store", (q) => q.eq("store_id", args.store_id!))
        .collect()) as OrderDoc[];
    } else {
      rows = (await ctx.db.query("orders").collect()) as OrderDoc[];
    }
    if (args.store_id && args.status) {
      rows = rows.filter((o) => o.store_id === args.store_id);
    }
    const customers = new Map(
      ((await ctx.db.query("customers").collect()) as CustomerDoc[]).map((c) => [
        c._id,
        c,
      ]),
    );
    const stores = new Map(
      ((await ctx.db.query("stores").collect()) as StoreDoc[]).map((s) => [
        s._id,
        s,
      ]),
    );
    const orderItems = (await ctx.db
      .query("order_items")
      .collect()) as OrderItemDoc[];
    const itemCounts = new Map<string, number>();
    for (const i of orderItems) {
      itemCounts.set(i.order_id, (itemCounts.get(i.order_id) ?? 0) + i.quantity);
    }
    let enriched: OrderListRow[] = rows.map((o) => {
      const c = customers.get(o.customer_id);
      return {
        ...o,
        customer_name:
          c?.display_name ?? `${c?.phone_country_code ?? ""}${c?.phone_number ?? ""}`,
        store_name: stores.get(o.store_id)?.name,
        item_count: itemCounts.get(o._id) ?? 0,
      };
    });
    if (args.search) {
      const s = args.search.toLowerCase();
      enriched = enriched.filter(
        (o) =>
          o.order_number.toLowerCase().includes(s) ||
          (o.customer_name ?? "").toLowerCase().includes(s),
      );
    }
    enriched.sort((a, b) => b.placed_at - a.placed_at);
    return paginate(enriched, args);
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
