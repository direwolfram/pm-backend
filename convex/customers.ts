import { v } from "convex/values";
import { anyApi } from "convex/server";
import { query, mutation, internalMutation } from "./functions";
import { boundedPageArgs, money, now, pageResponse, unwrapCursor, wrapCursor } from "./helpers";
import {
  CUSTOMER_ORDER_STATS_VERSION,
  customerSearchText,
  orderCountsForCustomerStats,
} from "./lib/customerAggregates";
import {
  CUSTOMER_SEARCH_TOKENS_VERSION,
  customerSearchMigrationComplete,
  customerSearchTokensForQuery,
  markCustomerSearchMigrationComplete,
  searchCustomersPage,
  syncCustomerSearchTokens,
} from "./lib/customerSearchTokens";
import { SEARCH_TOTAL_UNKNOWN } from "./lib/productSearchTokens";
import {
  applyListCountChange,
  customerCountKeys,
  customerTotalKey,
  exactListTotal,
} from "./listCounts";
import type {
  AddressDoc,
  CustomerDoc,
  OrderDoc,
  SupportTicketDoc,
} from "./model";

const CUSTOMER_BACKFILL_LIMIT = 100;

/**
 * Hard cap on documents a single list request may scan outside its returned
 * page (counter-missing totals). Index ranges cannot be counted without
 * reading them, so these domains are read with take(CAP + 1) and rejected
 * explicitly when larger — never a full-range fallback collect.
 */
export const CUSTOMER_LIST_SCAN_CAP = 512;

function customerListScope(args: {
  search?: string;
  status?: CustomerDoc["status"];
}) {
  return {
    q: "customers.list",
    search: args.search?.trim().toLowerCase() ?? "",
    status: args.status ?? "",
  };
}

async function pageCustomers(
  ctx: { db: any },
  args: {
    search?: string;
    status?: CustomerDoc["status"];
    limit?: number;
    offset?: number;
    cursor?: string | null;
  },
): Promise<{
  rows: CustomerDoc[];
  pagination: {
    isDone: boolean;
    nextCursor: string | null;
    total: number;
    totalIsExact?: boolean;
  };
  searchMigrationPending?: boolean;
}> {
  const pageArgs = boundedPageArgs(args);
  const limit = pageArgs.limit;
  const useOffset = args.offset !== undefined && args.cursor === undefined;
  const scope = customerListScope(args);
  const cursor = unwrapCursor(scope, args.cursor);
  const isSearch = !!args.search?.trim();
  if (isSearch) {
    const tokens = customerSearchTokensForQuery(args.search!.trim());
    if (tokens.length === 0) {
      return {
        rows: [],
        pagination: {
          isDone: true,
          nextCursor: null,
          total: SEARCH_TOTAL_UNKNOWN,
          totalIsExact: false,
        },
      };
    }
    if (!(await customerSearchMigrationComplete(ctx))) {
      // Explicit migration state: the customerSearchTokens backfill has not
      // completed, so search reports itself unavailable rather than falling
      // back to a full-match collect. Run
      // customers.backfillCustomerSearchTokens.
      return {
        rows: [],
        pagination: {
          isDone: true,
          nextCursor: null,
          total: SEARCH_TOTAL_UNKNOWN,
          totalIsExact: false,
        },
        searchMigrationPending: true,
      };
    }
    // Versioned search semantics: genuine cursor pagination over the
    // customerSearchTokens stream. Per-request work is one page-sized
    // paginated token-index read plus at most `limit` customer gets —
    // independent of the match count. Totals for arbitrary search are
    // explicitly non-exact (counting matches requires reading them): total
    // is the SEARCH_TOTAL_UNKNOWN sentinel with totalIsExact false.
    const page = await searchCustomersPage(ctx, {
      tokens,
      status: args.status,
      limit,
      cursor,
    });
    return {
      rows: page.rows,
      pagination: {
        isDone: page.isDone,
        nextCursor:
          page.isDone || !page.continueCursor
            ? null
            : wrapCursor(scope, page.continueCursor),
        total: SEARCH_TOTAL_UNKNOWN,
        totalIsExact: false,
      },
    };
  }
  const makeBuilder = () =>
    args.status
      ? ctx.db
          .query("customers")
          .withIndex("by_status_created", (q: any) =>
            q.eq("status", args.status!),
          )
      : ctx.db.query("customers").withIndex("by_created");
  // Exact total: maintained counters (O(1)). Missing counter rows use a
  // bounded scan that rejects over-cap domains explicitly — never a
  // request-time full-range collect.
  const maintained = await exactListTotal(ctx, "customers", customerTotalKey(args));
  let total = maintained;
  if (total === undefined) {
    const rows = await makeBuilder().take(CUSTOMER_LIST_SCAN_CAP + 1);
    if (rows.length > CUSTOMER_LIST_SCAN_CAP) {
      throw new Error(
        `Customer list counters are missing for this filter and more than ${CUSTOMER_LIST_SCAN_CAP} customers match; run listCounts.reconcileListCounts for scope "customers" before querying`,
      );
    }
    total = rows.length;
  }
  const ordered = makeBuilder().order("desc");
  if (!useOffset) {
    const result = await ordered.paginate({
      numItems: limit,
      cursor,
    });
    return {
      rows: result.page as CustomerDoc[],
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
  const rows = (await ordered.take(limit + pageArgs.offset + 1)) as CustomerDoc[];
  return {
    rows: rows.slice(pageArgs.offset, pageArgs.offset + limit),
    pagination: {
      isDone: rows.length <= pageArgs.offset + limit,
      nextCursor: null,
      total,
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
  const { rows, pagination, searchMigrationPending } = await pageCustomers(ctx, args);
  const data = rows.map((c) => ({
    ...c,
    order_count: c.order_count ?? 0,
    total_spend: money(c.total_spend ?? 0),
  }));
  return {
    ...pageResponse(data, args, pagination),
    searchMigrationPending: searchMigrationPending ?? false,
  };
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
    const doc = {
      phone_country_code: args.phone_country_code,
      phone_number: args.phone_number,
      display_name: args.display_name,
      email: args.email,
      avatar_url: args.avatar_url,
      status: args.status ?? ("active" as const),
      referral_code: args.referral_code,
      marketing_opt_in: args.marketing_opt_in ?? false,
      search_text: customerSearchText(args),
      order_count: 0,
      total_spend: 0,
      customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
      customerSearchTokensVersion: CUSTOMER_SEARCH_TOKENS_VERSION,
      created_at: t,
      updated_at: t,
    };
    const id = await ctx.db.insert("customers", doc);
    await syncCustomerSearchTokens(ctx, { ...doc, _id: id } as CustomerDoc);
    await applyListCountChange(ctx, "customers", customerCountKeys, null, doc);
    return id;
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
    const after = (await ctx.db.get(args.id)) as CustomerDoc | null;
    if (after) await syncCustomerSearchTokens(ctx, after);
    await applyListCountChange(
      ctx,
      "customers",
      customerCountKeys,
      customer as CustomerDoc,
      { ...customer, status: args.status } as CustomerDoc,
    );
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
    const after = (await ctx.db.get(id)) as CustomerDoc | null;
    if (after) await syncCustomerSearchTokens(ctx, after);
    // display_name and email are searchable; any change to them (or to the
    // phone fields via updatePhone) must refresh the denormalized order
    // search text.
    if (patch.display_name !== undefined || patch.email !== undefined) {
      await ctx.scheduler.runAfter(0, anyApi.orders.refreshCustomerOrderSearch, {
        customer_id: id,
      });
    }
    return id;
  },
});

export const updatePhone = mutation({
  args: {
    id: v.id("customers"),
    phone_country_code: v.optional(v.string()),
    phone_number: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const customer = await ctx.db.get(args.id);
    if (!customer) throw new Error("Customer not found");
    const nextCountryCode = args.phone_country_code ?? customer.phone_country_code;
    const nextNumber = args.phone_number ?? customer.phone_number;
    if (
      nextCountryCode !== customer.phone_country_code ||
      nextNumber !== customer.phone_number
    ) {
      const duplicate = await ctx.db
        .query("customers")
        .withIndex("by_phone", (q) =>
          q
            .eq("phone_country_code", nextCountryCode)
            .eq("phone_number", nextNumber),
        )
        .first();
      if (duplicate && duplicate._id !== args.id) {
        throw new Error("Customer phone already exists");
      }
      await ctx.db.patch(args.id, {
        phone_country_code: nextCountryCode,
        phone_number: nextNumber,
        search_text: customerSearchText({
          ...customer,
          phone_country_code: nextCountryCode,
          phone_number: nextNumber,
        }),
        updated_at: now(),
      });
      const after = (await ctx.db.get(args.id)) as CustomerDoc | null;
      if (after) await syncCustomerSearchTokens(ctx, after);
      await ctx.scheduler.runAfter(0, anyApi.orders.refreshCustomerOrderSearch, {
        customer_id: args.id,
      });
    }
    return args.id;
  },
});

/**
 * Bounded per-customer reconciliation, concurrency-safe:
 * - Every live aggregate delta bumps `statsGeneration` transactionally.
 * - The backfill snapshots the generation into `reconcile_generation` when it
 *   (re)starts a reconciliation.
 * - While reconciling, `order_count`/`total_spend` stay at their last
 *   authoritative values (public reads never see partial results).
 * - The final chunk re-reads the customer in the same transaction it commits
 *   in: if the generation changed mid-scan, it restarts from scratch with the
 *   newer generation instead of overwriting live values with a stale
 *   snapshot. Otherwise it commits the recomputed totals and only then
 *   clears the temporary state.
 */
async function reconcileCustomerStatsChunk(
  ctx: { db: any; scheduler: any },
  customerId: string,
  cursor: string | null,
) {
  const customer = (await ctx.db.get(customerId)) as CustomerDoc | null;
  if (!customer) return { done: true, patched: 0 };
  if (
    customer.reconcile_cursor === undefined ||
    customer.reconcile_totals === undefined ||
    customer.reconcile_generation === undefined
  ) {
    // No reconciliation in flight (already committed or never started).
    return { done: true, patched: 0 };
  }
  const effectiveCursor = cursor ?? customer.reconcile_cursor;
  const result = await ctx.db
    .query("orders")
    .withIndex("by_customer", (q) => q.eq("customer_id", customerId))
    .order("asc")
    .paginate({ numItems: 100, cursor: effectiveCursor });
  const running = { ...customer.reconcile_totals };
  for (const order of result.page as OrderDoc[]) {
    const stats = orderCountsForCustomerStats(order);
    running.order_count += stats.order_count;
    running.total_spend += stats.total_spend;
  }
  if (!result.isDone) {
    await ctx.db.patch(customerId as any, {
      reconcile_cursor: result.continueCursor,
      reconcile_totals: running,
    });
    await ctx.scheduler.runAfter(
      0,
      anyApi.customers.continueCustomerOrderStatsReconcile,
      { customer_id: customerId },
    );
    return { done: false, patched: 0 };
  }
  const currentGeneration = customer.statsGeneration ?? 0;
  if (currentGeneration !== customer.reconcile_generation) {
    // Live order mutations committed while we scanned: discard the stale
    // snapshot and restart with the current generation. Live deltas were
    // applied to the authoritative totals already, and the restarted scan
    // recomputes from full history including those orders.
    await ctx.db.patch(customerId as any, {
      reconcile_cursor: null,
      reconcile_generation: currentGeneration,
      reconcile_totals: { order_count: 0, total_spend: 0 },
    });
    await ctx.scheduler.runAfter(
      0,
      anyApi.customers.continueCustomerOrderStatsReconcile,
      { customer_id: customerId },
    );
    return { done: false, restarted: true, patched: 0 };
  }
  const finalTotals = {
    order_count: running.order_count,
    total_spend: money(running.total_spend),
  };
  const changed =
    customer.order_count !== finalTotals.order_count ||
    customer.total_spend !== finalTotals.total_spend ||
    customer.customerStatsVersion !== CUSTOMER_ORDER_STATS_VERSION;
  await ctx.db.patch(customerId as any, {
    ...(changed
      ? {
          order_count: finalTotals.order_count,
          total_spend: finalTotals.total_spend,
          customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
        }
      : {}),
    reconcile_cursor: undefined,
    reconcile_generation: undefined,
    reconcile_totals: undefined,
  });
  return { done: true, patched: changed ? 1 : 0 };
}

export const continueCustomerOrderStatsReconcile = internalMutation({
  args: { customer_id: v.id("customers") },
  handler: async (ctx, args) => {
    return await reconcileCustomerStatsChunk(ctx, args.customer_id, null);
  },
});

/**
 * Backfills customerSearchTokens rows for customers written before the token
 * stream existed (also fills missing search_text first). Drains in bounded
 * batches via the by_customer_search_tokens_version index and records
 * completion in transitionState ("customerSearchTokens"), which flips list
 * search from the explicit migration-pending state to cursor-paginated
 * token search.
 */
export const backfillCustomerSearchTokens = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const result = await ctx.db
      .query("customers")
      .withIndex("by_customer_search_tokens_version", (q) =>
        q.lt("customerSearchTokensVersion", CUSTOMER_SEARCH_TOKENS_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    let synced = 0;
    for (const customer of result.page as CustomerDoc[]) {
      const searchText = customer.search_text ?? customerSearchText(customer);
      if (customer.search_text !== searchText) {
        await ctx.db.patch(customer._id, { search_text: searchText });
      }
      await syncCustomerSearchTokens(ctx, { ...customer, search_text: searchText });
      synced += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        anyApi.customers.backfillCustomerSearchTokens,
        { limit, cursor: result.continueCursor },
      );
    } else {
      await markCustomerSearchMigrationComplete(ctx);
    }
    return {
      processed: result.page.length,
      synced,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
      complete: result.isDone,
    };
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
      .withIndex("by_customer_stats_version", (q) =>
        // Stale means missing (undefined) OR any version older than the
        // current one.
        q.lt("customerStatsVersion", CUSTOMER_ORDER_STATS_VERSION),
      )
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const customers = result.page as CustomerDoc[];
    let queued = 0;
    for (const customer of customers) {
      const searchText = customerSearchText(customer);
      // Initialize bounded reconciliation state and schedule the chunked
      // reconciliation (Convex allows one paginated query per execution, so
      // per-customer order scans run in their own continuations). The
      // generation snapshot makes the scan concurrency-safe.
      await ctx.db.patch(customer._id as any, {
        ...(customer.search_text !== searchText
          ? { search_text: searchText }
          : {}),
        reconcile_cursor: null,
        reconcile_generation: customer.statsGeneration ?? 0,
        reconcile_totals: { order_count: 0, total_spend: 0 },
      });
      await ctx.scheduler.runAfter(
        0,
        anyApi.customers.continueCustomerOrderStatsReconcile,
        { customer_id: customer._id },
      );
      queued += 1;
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.customers.backfillCustomerOrderStats, {
        limit,
        cursor: result.continueCursor,
      });
    }
    return {
      processed: customers.length,
      patched: queued,
      nextCursor: result.continueCursor,
      remainingMayExist: !result.isDone,
    };
  },
});
