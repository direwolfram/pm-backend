import { v } from "convex/values";
import { query, mutation, internalMutation } from "./functions";
import { boundedPageArgs, money, now, pageResponse } from "./helpers";
import {
  CUSTOMER_ORDER_STATS_VERSION,
  customerSearchText,
  orderCountsForCustomerStats,
} from "./lib/customerAggregates";
import type {
  AddressDoc,
  CustomerDoc,
  OrderDoc,
  SupportTicketDoc,
} from "./model";

async function pageCustomers(
  ctx: { db: any },
  args: {
    search?: string;
    status?: CustomerDoc["status"];
    limit?: number;
    offset?: number;
    cursor?: string;
  },
) {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const offset = args.cursor ? 0 : pageArgs.offset;
  const fetchLimit = Math.min(limit + offset + 1, 201);
  const cursorCustomer = args.cursor
    ? ((await ctx.db.get(args.cursor as any)) as CustomerDoc | null)
    : null;
  let builder;
  if (args.search?.trim()) {
    builder = ctx.db
      .query("customers")
      .withSearchIndex("search_customers", (q: any) => {
        let s = q.search("search_text", args.search!.trim().toLowerCase());
        if (args.status) s = s.eq("status", args.status);
        return s;
      });
  } else if (args.status) {
    builder = ctx.db
      .query("customers")
      .withIndex("by_status_created", (q: any) => {
        const range = q.eq("status", args.status);
        return cursorCustomer
          ? range.lt("created_at", cursorCustomer.created_at)
          : range;
      });
  } else {
    builder = ctx.db.query("customers").withIndex("by_created", (q: any) =>
      cursorCustomer ? q.lt("created_at", cursorCustomer.created_at) : q,
    );
  }
  const rows = ((await builder.order("desc").take(fetchLimit)) as CustomerDoc[]).slice(
    offset,
    offset + limit + 1,
  );
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function listHandler(
  ctx: { db: any },
  args: {
    search?: string;
    status?: CustomerDoc["status"];
    limit?: number;
    offset?: number;
    cursor?: string;
  },
) {
  const { rows, hasMore } = await pageCustomers(ctx, args);
  const data = rows.map((c) => ({
    ...c,
    order_count: c.order_count ?? 0,
    total_spend: money(c.total_spend ?? 0),
  }));
  return pageResponse(data, args, hasMore);
}

export const list = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("guest"),
        v.literal("active"),
        v.literal("blocked"),
        v.literal("deleted"),
      ),
    ),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await listHandler(ctx, args);
  },
});

export const get = query({
  args: { id: v.id("customers") },
  handler: async (ctx, args) => {
    const customer = (await ctx.db.get(args.id)) as CustomerDoc | null;
    if (!customer) throw new Error("Customer not found");
    const addresses = (await ctx.db
      .query("addresses")
      .withIndex("by_customer", (q) => q.eq("customer_id", args.id))
      .collect()) as AddressDoc[];
    const settings = await ctx.db
      .query("customer_settings")
      .withIndex("by_customer", (q) => q.eq("customer_id", args.id))
      .first();
    const orders = (await ctx.db
      .query("orders")
      .withIndex("by_customer", (q) => q.eq("customer_id", args.id))
      .collect()) as OrderDoc[];
    orders.sort((a, b) => b.placed_at - a.placed_at);
    const tickets = (await ctx.db
      .query("support_tickets")
      .withIndex("by_customer", (q) => q.eq("customer_id", args.id))
      .collect()) as SupportTicketDoc[];
    return {
      ...customer,
      addresses,
      settings,
      recent_orders: orders.slice(0, 10),
      tickets,
    };
  },
});

export const setStatus = mutation({
  args: {
    id: v.id("customers"),
    status: v.union(
      v.literal("guest"),
      v.literal("active"),
      v.literal("blocked"),
      v.literal("deleted"),
    ),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.id);
    if (!customer) throw new Error("Customer not found");
    await ctx.db.patch(args.id, { status: args.status, updated_at: now() });
    return args.id;
  },
});

export const updateProfile = mutation({
  args: {
    id: v.id("customers"),
    display_name: v.optional(v.string()),
    email: v.optional(v.string()),
    marketing_opt_in: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...patch } = args;
    const customer = await ctx.db.get(id);
    if (!customer) throw new Error("Customer not found");
    await ctx.db.patch(id, {
      ...patch,
      search_text: customerSearchText({ ...customer, ...patch }),
      updated_at: now(),
    });
    return id;
  },
});

export const backfillCustomerOrderStats = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const customers = (await ctx.db
      .query("customers")
      .withIndex("by_customer_stats_version", (q) =>
        q.eq("customerStatsVersion", undefined),
      )
      .take(limit)) as CustomerDoc[];
    let patched = 0;
    for (const customer of customers) {
      const orders = (await ctx.db
        .query("orders")
        .withIndex("by_customer", (q) => q.eq("customer_id", customer._id))
        .collect()) as OrderDoc[];
      const totals = orders.reduce(
        (acc, order) => {
          const stats = orderCountsForCustomerStats(order);
          acc.order_count += stats.order_count;
          acc.total_spend += stats.total_spend;
          return acc;
        },
        { order_count: 0, total_spend: 0 },
      );
      await ctx.db.patch(customer._id as any, {
        order_count: totals.order_count,
        total_spend: money(totals.total_spend),
        search_text: customer.search_text ?? customerSearchText(customer),
        customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
      });
      patched += 1;
    }
    return {
      processed: customers.length,
      patched,
      remainingMayExist: customers.length >= limit,
    };
  },
});
