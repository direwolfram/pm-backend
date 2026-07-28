import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation, internalQuery } from "./functions";
import {
  assertNonNegative,
  assertPositiveQuantity,
  boundedPageArgs,
  now,
  pageResponse,
  unwrapCursor,
  wrapCursor,
} from "./helpers";
import { applyOrderStatsChange } from "./lib/customerAggregates";
import {
  applyListCountChange,
  exactListTotal,
  orderCountKeys,
  orderTotalKey,
} from "./listCounts";
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

export const ORDER_SUMMARY_VERSION = 2;
const ORDER_SUMMARY_BATCH_LIMIT = 100;
/**
 * Documented hard cap on line items per order, enforced at insert time and
 * validated during summary recomputation (never silently truncated).
 */
export const MAX_ORDER_ITEMS = 1_000;

/**
 * Hard cap on the number of order documents a single list request may scan
 * outside of its returned page.
 *
 * Convex search queries cannot be paginated or range-filtered by placed_at,
 * and an index range cannot be counted without reading it. So for search
 * result sets, date-window totals, and missing maintained counters the only
 * correct option is a bounded scan: each request reads at most
 * ORDER_LIST_SCAN_CAP + 1 documents and explicitly rejects the query when
 * the domain exceeds the cap, instead of silently returning incomplete
 * results. Equality-filtered (status/store) queries without a date window
 * never scan: their exact totals come from transactionally maintained
 * listCounts rows and their pages from index pagination.
 */
export const ORDER_LIST_SCAN_CAP = 512;

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

export function orderSearchText(order: OrderDoc, customer?: CustomerDoc | null) {
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

async function computeOrderItemCount(ctx: { db: any }, orderId: string) {
  const items = (await ctx.db
    .query("order_items")
    .withIndex("by_order", (q: any) => q.eq("order_id", orderId))
    .take(MAX_ORDER_ITEMS + 1)) as OrderItemDoc[];
  if (items.length > MAX_ORDER_ITEMS) {
    throw new Error(
      `Order ${orderId} exceeds the ${MAX_ORDER_ITEMS} line-item cap`,
    );
  }
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

async function patchOrderSummary(ctx: { db: any }, order: OrderDoc) {
  const [customer, itemCount] = await Promise.all([
    ctx.db.get(order.customer_id as any),
    computeOrderItemCount(ctx, order._id),
  ]);
  const next = {
    item_count: itemCount,
    order_search_text: orderSearchText(order, customer as CustomerDoc | null),
    orderSummaryVersion: ORDER_SUMMARY_VERSION,
  };
  if (
    order.item_count === next.item_count &&
    order.order_search_text === next.order_search_text &&
    order.orderSummaryVersion === next.orderSummaryVersion
  ) {
    return false;
  }
  await ctx.db.patch(order._id as any, next);
  return true;
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

function orderListScope(args: {
  status?: OrderStatus;
  store_id?: string;
  search?: string;
  placed_from?: number;
  placed_to?: number;
}) {
  return {
    q: "orders.list",
    search: args.search?.trim().toLowerCase() ?? "",
    status: args.status ?? "",
    store_id: args.store_id ?? "",
    placed_from: args.placed_from ?? "",
    placed_to: args.placed_to ?? "",
  };
}

/**
 * Newest-first order with a stable tie-breaker, matching the non-search
 * index ordering (placed_at desc, _id desc). Applied to capped search match
 * sets so search pages follow the same deterministic contract as index
 * pages; equal placed_at timestamps can never reorder across requests.
 */
export function compareOrdersNewestFirst(a: OrderDoc, b: OrderDoc) {
  if (a.placed_at !== b.placed_at) return b.placed_at - a.placed_at;
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

/**
 * Bounded exact count of a query domain. Reads at most cap + 1 documents;
 * throws an explicit error when the domain is larger so callers never see a
 * silently truncated total.
 */
async function boundedDomainCount(
  buildQuery: () => { take: (n: number) => Promise<unknown[]> },
  cap: number,
  tooLargeMessage: string,
) {
  const rows = await buildQuery().take(cap + 1);
  if (rows.length > cap) throw new Error(tooLargeMessage);
  return rows.length;
}

async function pageOrders(
  ctx: { db: any },
  args: {
    status?: OrderStatus;
    store_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
    cursor?: string | null;
    placed_from?: number;
    placed_to?: number;
  },
) {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const useOffset = args.offset !== undefined && args.cursor === undefined;
  const scope = orderListScope(args);
  const cursor = unwrapCursor(scope, args.cursor);
  const isSearch = !!args.search?.trim();
  const hasWindow = args.placed_from !== undefined || args.placed_to !== undefined;
  const inWindow = (order: OrderDoc) =>
    (args.placed_from === undefined || order.placed_at >= args.placed_from) &&
    (args.placed_to === undefined || order.placed_at <= args.placed_to);

  if (isSearch) {
    // Search domain: status/store are search filter fields; the placed_at
    // window is applied to the full match set BEFORE the logical page is
    // produced, so pages are complete (never post-filtered fixed pages).
    // Convex search queries cannot be paginated, so the match set is read
    // with a hard cap: requests stay bounded no matter how large order
    // history grows, and a match domain larger than the cap is rejected
    // explicitly rather than silently truncated.
    const rawMatches = (await ctx.db
      .query("orders")
      .withSearchIndex("search_orders", (q: any) => {
        let s = q.search("order_search_text", args.search!.trim().toLowerCase());
        if (args.status) s = s.eq("status", args.status);
        if (args.store_id) s = s.eq("store_id", args.store_id);
        return s;
      })
      .take(ORDER_LIST_SCAN_CAP + 1)) as OrderDoc[];
    // A full take means more matches may exist that this request did not
    // read; filtering those down to a page could silently drop in-window
    // results, so reject instead of returning an incomplete result set.
    if (rawMatches.length > ORDER_LIST_SCAN_CAP) {
      throw new Error(
        `Search matched more than ${ORDER_LIST_SCAN_CAP} orders; narrow the search term, status, store, or date filters`,
      );
    }
    const matches = rawMatches.filter(inWindow);
    // Search indexes return relevance order, which is neither the
    // established newest-first contract nor stable across requests. Sort the
    // (capped) match set deterministically so pages, offsets, and cursor
    // continuations all traverse the same total order.
    matches.sort(compareOrdersNewestFirst);
    const skip = useOffset
      ? pageArgs.offset
      : cursor === null
        ? 0
        : Number(cursor);
    if (!Number.isInteger(skip) || skip < 0 || skip > matches.length) {
      throw new Error("Invalid cursor: request a fresh first page");
    }
    const page = matches.slice(skip, skip + limit);
    const nextSkip = skip + limit;
    return {
      rows: page,
      pagination: {
        isDone: nextSkip >= matches.length,
        nextCursor:
          useOffset || nextSkip >= matches.length
            ? null
            : wrapCursor(scope, String(nextSkip)),
        total: matches.length,
      },
    };
  }

  const indexName = orderIndex(args);
  const makeBuilder = () =>
    ctx.db.query("orders").withIndex(indexName, (q: any) => {
      const withBounds = (range: any) => {
        let out = range;
        if (args.placed_to !== undefined) out = out.lte("placed_at", args.placed_to);
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
  // Exact totals: maintained counters for equality-only queries (O(1)).
  // Date-window totals and missing counter rows cannot be produced without
  // reading the domain, so they use a bounded scan that rejects domains
  // larger than the cap instead of scanning unboundedly or guessing.
  const maintained = hasWindow
    ? undefined
    : await exactListTotal(ctx, "orders", orderTotalKey(args));
  const total =
    maintained ??
    (await boundedDomainCount(
      makeBuilder,
      ORDER_LIST_SCAN_CAP,
      hasWindow
        ? `More than ${ORDER_LIST_SCAN_CAP} orders fall inside this date window; narrow placed_from/placed_to or add a status/store filter`
        : `Order list counters are missing for this filter and more than ${ORDER_LIST_SCAN_CAP} orders match; run listCounts.reconcileListCounts for scope "orders" before querying`,
    ));

  const ordered = makeBuilder().order("desc");
  if (!useOffset) {
    const result = await ordered.paginate({
      numItems: limit,
      cursor,
    });
    return {
      rows: result.page as OrderDoc[],
      pagination: {
        isDone: result.isDone,
        nextCursor:
          result.isDone || !result.continueCursor
            ? null
            : wrapCursor(scope, result.continueCursor),
        total,
      },
    };
  }
  const rows = (await ordered.take(limit + pageArgs.offset + 1)) as OrderDoc[];
  return {
    rows: rows.slice(pageArgs.offset, pageArgs.offset + limit),
    pagination: { isDone: rows.length <= pageArgs.offset + limit, nextCursor: null, total },
  };
}

async function enrichOrders(ctx: { db: any }, orders: OrderDoc[]) {
  const [customers, stores] = await Promise.all([
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
  ]);
  const customersById = new Map(customers);
  const storesById = new Map(stores);
  return orders.map((o): OrderListRow => {
    const c = customersById.get(o.customer_id);
    return {
      ...o,
      customer_name:
        c?.display_name ?? `${c?.phone_country_code ?? ""}${c?.phone_number ?? ""}`,
      store_name: storesById.get(o.store_id)?.name,
      item_count: o.item_count ?? 0,
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
    cursor?: string | null;
    placed_from?: number;
    placed_to?: number;
  },
) {
  const { rows, pagination } = await pageOrders(ctx, args);
  const enriched = await enrichOrders(ctx, rows);
  return pageResponse(enriched, args, pagination);
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

/**
 * orders.list — bounded contract (v2).
 *
 * The pre-v2 endpoint scanned the whole orders/customers/stores/order_items
 * tables per request, which let it offer arbitrary offsets, exact totals for
 * any domain, and naive substring search. Those semantics cannot be
 * preserved with bounded reads, so this endpoint is an explicit v2 contract:
 *
 * - Ordering: deterministic newest-first (placed_at desc, _id desc) on every
 *   path, with timestamp ties broken by _id so pages never overlap or gap.
 * - Pagination: opaque, filter-fingerprinted cursors are the primary API.
 *   Legacy `offset` is honored up to MAX_COMPAT_OFFSET (200) and rejected
 *   with a documented error beyond that instead of silently truncating.
 * - Totals: exact numeric totals on every path — O(1) maintained counters
 *   for equality filters, a bounded scan (ORDER_LIST_SCAN_CAP) for search,
 *   date-window, and counter-missing domains. Domains above the cap are
 *   rejected with an explicit error, never an estimate or capped value.
 * - Search semantics (deliberate change from v1): token-prefix matching over
 *   the denormalized order_search_text (order number, customer name, phone),
 *   not arbitrary substring matching. A partial token that is not a word
 *   prefix no longer matches; this is what makes search indexed and bounded.
 * - Caller audit: the only in-repo caller (src/pages/Orders.tsx) uses
 *   status/store/search/limit only — no offset, cursor, or date window — and
 *   is fully compatible with this contract. Deep-offset consumers must
 *   migrate to cursor pagination.
 */
export const list = query({
  args: {
    status: v.optional(orderStatus),
    store_id: v.optional(v.id("stores")),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
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

export const create = mutation({
  args: {
    order_number: v.string(),
    customer_id: v.id("customers"),
    cart_id: v.optional(v.id("carts")),
    store_id: v.id("stores"),
    address_id: v.id("addresses"),
    delivery_mode: v.union(
      v.literal("express"),
      v.literal("savers"),
      v.literal("sari-sari"),
    ),
    status: v.optional(orderStatus),
    payment_status: v.optional(paymentStatus),
    currency: v.optional(v.string()),
    subtotal_amount: v.number(),
    discount_amount: v.optional(v.number()),
    delivery_fee_amount: v.optional(v.number()),
    total_amount: v.number(),
    customer_notes: v.optional(v.string()),
    placed_at: v.optional(v.number()),
    estimated_delivery_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const [customer, store, address] = await Promise.all([
      ctx.db.get(args.customer_id),
      ctx.db.get(args.store_id),
      ctx.db.get(args.address_id),
    ]);
    if (!customer) throw new Error("Customer not found");
    if (!store) throw new Error("Store not found");
    if ((store as { deleting_at?: number }).deleting_at) {
      throw new Error("Store is being deleted");
    }
    if (!address) throw new Error("Address not found");
    const order = {
      order_number: args.order_number,
      customer_id: args.customer_id,
      cart_id: args.cart_id,
      store_id: args.store_id,
      address_id: args.address_id,
      delivery_mode: args.delivery_mode,
      status: args.status ?? "pending_payment",
      payment_status: args.payment_status ?? "pending",
      currency: args.currency ?? "PHP",
      subtotal_amount: args.subtotal_amount,
      discount_amount: args.discount_amount ?? 0,
      delivery_fee_amount: args.delivery_fee_amount ?? 0,
      total_amount: args.total_amount,
      customer_notes: args.customer_notes,
      item_count: 0,
      placed_at: args.placed_at ?? now(),
      estimated_delivery_at: args.estimated_delivery_at,
    } as Omit<OrderDoc, "_id" | "_creationTime">;
    const id = await ctx.db.insert("orders", {
      ...order,
      order_search_text: orderSearchText(
        { ...order, _id: "" } as OrderDoc,
        customer as CustomerDoc,
      ),
      orderSummaryVersion: ORDER_SUMMARY_VERSION,
    });
    await applyOrderStatsChange(ctx, null, { ...order, _id: id } as OrderDoc);
    await applyListCountChange(ctx, "orders", orderCountKeys, null, order);
    return id;
  },
});

export const updateAmounts = mutation({
  args: {
    id: v.id("orders"),
    subtotal_amount: v.optional(v.number()),
    discount_amount: v.optional(v.number()),
    delivery_fee_amount: v.optional(v.number()),
    total_amount: v.number(),
  },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    const next = {
      ...order,
      subtotal_amount: args.subtotal_amount ?? order.subtotal_amount,
      discount_amount: args.discount_amount ?? order.discount_amount,
      delivery_fee_amount: args.delivery_fee_amount ?? order.delivery_fee_amount,
      total_amount: args.total_amount,
    };
    await ctx.db.patch(args.id, {
      subtotal_amount: next.subtotal_amount,
      discount_amount: next.discount_amount,
      delivery_fee_amount: next.delivery_fee_amount,
      total_amount: next.total_amount,
    });
    await applyOrderStatsChange(ctx, order, next);
    return args.id;
  },
});

export const reassignCustomer = mutation({
  args: { id: v.id("orders"), customer_id: v.id("customers") },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    const customer = (await ctx.db.get(args.customer_id)) as CustomerDoc | null;
    if (!customer) throw new Error("Customer not found");
    const next = { ...order, customer_id: args.customer_id };
    await ctx.db.patch(args.id, {
      customer_id: args.customer_id,
      order_search_text: orderSearchText(next, customer),
      orderSummaryVersion: ORDER_SUMMARY_VERSION,
    });
    await applyOrderStatsChange(ctx, order, next);
    return args.id;
  },
});

export const remove = mutation({
  args: { id: v.id("orders") },
  handler: async (ctx, args) => {
    const order = (await ctx.db.get(args.id)) as OrderDoc | null;
    if (!order) return;
    // Restrict semantics: an order with items cannot be deleted. Indexed
    // existence check with a single read.
    const item = await ctx.db
      .query("order_items")
      .withIndex("by_order", (q) => q.eq("order_id", args.id))
      .first();
    if (item) {
      throw new Error("Delete order items before deleting the order");
    }
    await ctx.db.delete(args.id);
    await applyOrderStatsChange(ctx, order, null);
    await applyListCountChange(ctx, "orders", orderCountKeys, order, null);
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
    await applyListCountChange(ctx, "orders", orderCountKeys, order, {
      ...order,
      status: args.status,
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

export const createItem = mutation({
  args: {
    order_id: v.id("orders"),
    product_id: v.id("products"),
    sku_id: v.id("skus"),
    product_name_snapshot: v.string(),
    sku_label_snapshot: v.string(),
    quantity: v.number(),
    unit_price: v.number(),
    compare_at_price: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertPositiveQuantity(args.quantity);
    assertNonNegative(args.unit_price, "unit_price");
    if (args.compare_at_price !== undefined) {
      assertNonNegative(args.compare_at_price, "compare_at_price");
    }
    const order = (await ctx.db.get(args.order_id)) as OrderDoc | null;
    if (!order) throw new Error("Order not found");
    const [product, sku] = await Promise.all([
      ctx.db.get(args.product_id as any),
      ctx.db.get(args.sku_id as any),
    ]);
    if ((product as { deleting_at?: number } | null)?.deleting_at) {
      throw new Error("Product is being deleted");
    }
    if ((sku as { deleting_at?: number } | null)?.deleting_at) {
      throw new Error("SKU is being deleted");
    }
    // Derive the effective pre-write count BEFORE inserting so a missing
    // stored count cannot be recomputed with the new item already included
    // (which would double-count the new quantity).
    const preCount =
      order.item_count ?? (await computeOrderItemCount(ctx, args.order_id));
    const existingItems = await ctx.db
      .query("order_items")
      .withIndex("by_order", (q) => q.eq("order_id", args.order_id))
      .take(MAX_ORDER_ITEMS + 1);
    if (existingItems.length >= MAX_ORDER_ITEMS) {
      throw new Error(
        `An order can have at most ${MAX_ORDER_ITEMS} line items`,
      );
    }
    const id = await ctx.db.insert("order_items", {
      ...args,
      line_total: args.quantity * args.unit_price,
    });
    await ctx.db.patch(args.order_id, {
      item_count: preCount + args.quantity,
      orderSummaryVersion: ORDER_SUMMARY_VERSION,
    });
    return id;
  },
});

export const updateItem = mutation({
  args: {
    id: v.id("order_items"),
    order_id: v.optional(v.id("orders")),
    quantity: v.optional(v.number()),
    unit_price: v.optional(v.number()),
    compare_at_price: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const item = (await ctx.db.get(args.id)) as OrderItemDoc | null;
    if (!item) throw new Error("Order item not found");
    if (args.quantity !== undefined) assertPositiveQuantity(args.quantity);
    if (args.unit_price !== undefined) {
      assertNonNegative(args.unit_price, "unit_price");
    }
    if (args.compare_at_price !== undefined) {
      assertNonNegative(args.compare_at_price, "compare_at_price");
    }
    const nextOrderId = args.order_id ?? item.order_id;
    const nextQuantity = args.quantity ?? item.quantity;
    const nextUnitPrice = args.unit_price ?? item.unit_price;
    const nextOrder = (await ctx.db.get(nextOrderId as any)) as OrderDoc | null;
    if (!nextOrder) throw new Error("Order not found");
    await ctx.db.patch(args.id, {
      order_id: nextOrderId,
      quantity: nextQuantity,
      unit_price: nextUnitPrice,
      compare_at_price: args.compare_at_price,
      line_total: nextQuantity * nextUnitPrice,
    });
    const touched = new Set([item.order_id, nextOrderId]);
    for (const orderId of touched) {
      const order = (await ctx.db.get(orderId as any)) as OrderDoc | null;
      if (order) await patchOrderSummary(ctx, order);
    }
    return args.id;
  },
});

export const removeItem = mutation({
  args: { id: v.id("order_items") },
  handler: async (ctx, args) => {
    const item = (await ctx.db.get(args.id)) as OrderItemDoc | null;
    if (!item) return;
    await ctx.db.delete(args.id);
    const order = (await ctx.db.get(item.order_id as any)) as OrderDoc | null;
    if (order) await patchOrderSummary(ctx, order);
  },
});

export const backfillOrderListSummaries = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), ORDER_SUMMARY_BATCH_LIMIT);
    const result = await ctx.db
      .query("orders")
      .withIndex("by_order_summary_version", (q) =>
        // Stale means missing (undefined) OR any version older than the
        // current one; the index on (orderSummaryVersion, placed_at) selects
        // both without scanning current rows.
        q.lt("orderSummaryVersion", ORDER_SUMMARY_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const orders = result.page as OrderDoc[];
    let patched = 0;
    for (const order of orders) {
      if (await patchOrderSummary(ctx, order)) patched += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.orders.backfillOrderListSummaries, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      processed: orders.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});

export const refreshCustomerOrderSearch = internalMutation({
  args: {
    customer_id: v.id("customers"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const customer = (await ctx.db.get(args.customer_id)) as CustomerDoc | null;
    const limit = Math.min(Math.max(args.limit ?? 50, 1), ORDER_SUMMARY_BATCH_LIMIT);
    const result = await ctx.db
      .query("orders")
      .withIndex("by_customer", (q) => q.eq("customer_id", args.customer_id))
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let patched = 0;
    for (const order of result.page as OrderDoc[]) {
      const nextSearchText = orderSearchText(order, customer);
      if (order.order_search_text !== nextSearchText) {
        await ctx.db.patch(order._id as any, {
          order_search_text: nextSearchText,
          orderSummaryVersion: ORDER_SUMMARY_VERSION,
        });
        patched += 1;
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.orders.refreshCustomerOrderSearch, {
        customer_id: args.customer_id,
        cursor: result.continueCursor,
        limit,
      });
    }
    return {
      processed: result.page.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});

/**
 * Rollout/readiness probe for the order list summaries. Reports how many
 * orders are still behind ORDER_SUMMARY_VERSION (bounded sample: counts at
 * most ORDER_LIST_SCAN_CAP + 1 rows) so deploys can gate on
 * backfillOrderListSummaries before relying on search/item_count reads.
 */
export const orderSummaryReadiness = internalQuery({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("orders")
      .withIndex("by_order_summary_version", (q) =>
        q.lt("orderSummaryVersion", ORDER_SUMMARY_VERSION),
      )
      .take(ORDER_LIST_SCAN_CAP + 1);
    return {
      version: ORDER_SUMMARY_VERSION,
      stale: stale.length,
      overflow: stale.length > ORDER_LIST_SCAN_CAP,
      ready: stale.length === 0,
    };
  },
});

/**
 * Deep, idempotent reconciliation for order summaries. Unlike
 * backfillOrderListSummaries (which selects by version), this sweeps EVERY
 * order in fixed-size pages and recomputes item_count + order_search_text,
 * so state that is stale while carrying the current version (e.g. corrupted
 * by a historical bug or a direct DB edit) is also repaired. Patches do not
 * touch the scan ordering, so the continuation cursor stays valid across
 * batches and retries.
 */
export const reconcileOrderSummaries = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), ORDER_SUMMARY_BATCH_LIMIT);
    const result = await ctx.db
      .query("orders")
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let patched = 0;
    for (const order of result.page as OrderDoc[]) {
      if (await patchOrderSummary(ctx, order)) patched += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.orders.reconcileOrderSummaries, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      done: result.isDone,
      processed: result.page.length,
      patched,
      nextCursor: result.isDone ? undefined : result.continueCursor,
    };
  },
});
