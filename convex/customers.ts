import { v } from "convex/values";
import { anyApi } from "convex/server";
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

const CUSTOMER_BACKFILL_LIMIT = 100;

async function pageCustomers(
  ctx: { db: any },
  args: {
    search?: string;
    status?: CustomerDoc["status"];
    limit?: number;
    offset?: number;
    cursor?: string | null;
  },
) {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const fetchLimit = limit + pageArgs.offset + 1;
  const useOffset = args.offset !== undefined && args.cursor === undefined;
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
      .withIndex("by_status_created", (q: any) => q.eq("status", args.status));
  } else {
    builder = ctx.db.query("customers").withIndex("by_created");
  }
  const ordered = builder.order("desc");
  if (!useOffset) {
    const result = await ordered.paginate({
      numItems: limit,
      cursor: args.cursor ?? null,
    });
    return { rows: result.page as CustomerDoc[], pagination: result };
  }
  const rows = (await ordered.take(fetchLimit)) as CustomerDoc[];
  return {
    rows: rows.slice(pageArgs.offset, pageArgs.offset + limit),
    pagination: {
      isDone: rows.length <= pageArgs.offset + limit,
      nextCursor: null,
    },
  };
}

export async function listHandler(
  ctx: { db: any },
  args: {
    search?: string;
    status?: CustomerDoc["status"];
    limit?: number;
    offset?: number;
    cursor?: string | null;
  },
) {
  const { rows, pagination } = await pageCustomers(ctx, args);
  const data = rows.map((c) => ({
    ...c,
    order_count: c.order_count ?? 0,
    total_spend: money(c.total_spend ?? 0),
  }));
  return pageResponse(data, args, pagination);
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
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    return await listHandler(ctx, args);
  },
});

export const create = mutation({
  args: {
    phone_country_code: v.string(),
    phone_number: v.string(),
    display_name: v.optional(v.string()),
    email: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("guest"),
        v.literal("active"),
        v.literal("blocked"),
        v.literal("deleted"),
      ),
    ),
    referral_code: v.optional(v.string()),
    marketing_opt_in: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("customers")
      .withIndex("by_phone", (q) =>
        q
          .eq("phone_country_code", args.phone_country_code)
          .eq("phone_number", args.phone_number),
      )
      .first();
    if (duplicate) throw new Error("Customer phone already exists");
    const t = now();
    return await ctx.db.insert("customers", {
      phone_country_code: args.phone_country_code,
      phone_number: args.phone_number,
      display_name: args.display_name,
      email: args.email,
      avatar_url: args.avatar_url,
      status: args.status ?? "active",
      referral_code: args.referral_code,
      marketing_opt_in: args.marketing_opt_in ?? false,
      search_text: customerSearchText(args),
      order_count: 0,
      total_spend: 0,
      customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
      created_at: t,
      updated_at: t,
    });
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
    if (patch.display_name !== undefined) {
      await ctx.scheduler.runAfter(0, anyApi.orders.refreshCustomerOrderSearch, {
        customer_id: id,
      });
    }
    return id;
  },
});

export const backfillCustomerOrderStats = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? 50, 1),
      CUSTOMER_BACKFILL_LIMIT,
    );
    const result = await ctx.db
      .query("customers")
      .withIndex("by_created")
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const customers = result.page as CustomerDoc[];
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
      const patch = {
        order_count: totals.order_count,
        total_spend: money(totals.total_spend),
        search_text: customerSearchText(customer),
        customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
      };
      if (
        customer.order_count !== patch.order_count ||
        customer.total_spend !== patch.total_spend ||
        customer.search_text !== patch.search_text ||
        customer.customerStatsVersion !== patch.customerStatsVersion
      ) {
        await ctx.db.patch(customer._id as any, patch);
        patched += 1;
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.customers.backfillCustomerOrderStats, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      processed: customers.length,
      patched,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});
