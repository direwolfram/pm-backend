import { v } from "convex/values";
import { query, mutation } from "./functions";
import { now, paginate } from "./helpers";
import type {
  AddressDoc,
  CustomerDoc,
  OrderDoc,
  SupportTicketDoc,
} from "./model";

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
  },
  handler: async (ctx, args) => {
    let rows = (await ctx.db.query("customers").collect()) as CustomerDoc[];
    if (args.status) rows = rows.filter((c) => c.status === args.status);
    if (args.search) {
      const s = args.search.toLowerCase();
      rows = rows.filter(
        (c) =>
          (c.display_name ?? "").toLowerCase().includes(s) ||
          c.phone_number.includes(s) ||
          (c.email ?? "").toLowerCase().includes(s),
      );
    }
    const orders = (await ctx.db.query("orders").collect()) as OrderDoc[];
    const stats = new Map<string, { count: number; spend: number }>();
    for (const o of orders) {
      if (o.status === "cancelled" || o.status === "refunded") continue;
      const cur = stats.get(o.customer_id) ?? { count: 0, spend: 0 };
      cur.count += 1;
      cur.spend += o.total_amount;
      stats.set(o.customer_id, cur);
    }
    const enriched = rows
      .map((c) => ({
        ...c,
        order_count: stats.get(c._id)?.count ?? 0,
        total_spend: Math.round((stats.get(c._id)?.spend ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.created_at - a.created_at);
    return paginate(enriched, args);
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
    await ctx.db.patch(id, { ...patch, updated_at: now() });
    return id;
  },
});
