import type { CustomerDoc } from "../model";

/**
 * Cursor-paginated customer search over the customerSearchTokens stream —
 * the customer analogue of productSearchTokens (see that module for the
 * design). Convex search indexes cannot be paginated, so a search request
 * drives the by_token_created index on the query's first token in
 * newest-first order with a single page-sized paginated read (Convex permits
 * one .paginate() per function), post-filtering the remaining tokens and the
 * status filter from fields denormalized onto each token row. Request work
 * is proportional to the page size plus fixed metadata — never to the match
 * count.
 *
 * Versioned semantics (intentional contract change): matching is
 * whole-token, case-insensitive, order-independent, without stemming or
 * prefix matching — phone search requires the full number (the digits-only
 * concatenation "639123456789" is itself a token, so country-code-prefixed
 * full-number queries still match). Totals are non-exact: total = -1
 * (SEARCH_TOTAL_UNKNOWN) with totalIsExact = false, because counting an
 * arbitrary match set requires reading it. Until
 * customers.backfillCustomerSearchTokens records completion in
 * transitionState, list queries return an explicit searchMigrationPending
 * state instead of scanning match sets.
 */
export const CUSTOMER_SEARCH_TOKENS_VERSION = 1;
export const CUSTOMER_SEARCH_MIGRATION_STATE_KEY = "customerSearchTokens";

/** Hard ceiling on distinct search tokens indexed per customer. */
export const MAX_CUSTOMER_SEARCH_TOKENS = 24;

export interface CustomerSearchTokenDoc {
  _id: string;
  customer_id: string;
  token: string;
  tokens: string[];
  created_at: number;
  status: CustomerDoc["status"];
}

/** Lowercase alphanumeric word tokens, deduplicated. */
function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0),
    ),
  );
}

export function customerSearchTokensForText(searchText: string): string[] {
  return tokenize(searchText).slice(0, MAX_CUSTOMER_SEARCH_TOKENS);
}

export function customerSearchTokensForQuery(search: string): string[] {
  return tokenize(search).slice(0, MAX_CUSTOMER_SEARCH_TOKENS);
}

/**
 * Replace (or refresh) a customer's token rows in the same transaction as
 * the customer write. Reads and writes stay <= 2 *
 * MAX_CUSTOMER_SEARCH_TOKENS. Note created_at never changes, so only the
 * token set and status need reconciliation.
 */
export async function syncCustomerSearchTokens(
  ctx: { db: any },
  customer: CustomerDoc,
) {
  const existing = (await ctx.db
    .query("customerSearchTokens")
    .withIndex("by_customer", (q: any) => q.eq("customer_id", customer._id))
    .take(MAX_CUSTOMER_SEARCH_TOKENS + 1)) as CustomerSearchTokenDoc[];
  if (existing.length > MAX_CUSTOMER_SEARCH_TOKENS) {
    throw new Error(
      `Customer ${customer._id} has more than ${MAX_CUSTOMER_SEARCH_TOKENS} search token rows; reconcile with customers.backfillCustomerSearchTokens`,
    );
  }
  const tokens = customerSearchTokensForText(customer.search_text ?? "");
  const sameShape =
    existing.length === tokens.length &&
    tokens.every((token) => existing.some((row) => row.token === token)) &&
    existing.every(
      (row) =>
        row.status === customer.status &&
        row.created_at === customer.created_at &&
        row.tokens.join(" ") === tokens.join(" "),
    );
  if (sameShape) {
    if (customer.customerSearchTokensVersion !== CUSTOMER_SEARCH_TOKENS_VERSION) {
      await ctx.db.patch(customer._id, {
        customerSearchTokensVersion: CUSTOMER_SEARCH_TOKENS_VERSION,
      });
    }
    return;
  }
  for (const row of existing) {
    await ctx.db.delete(row._id);
  }
  for (const token of tokens) {
    await ctx.db.insert("customerSearchTokens", {
      customer_id: customer._id,
      token,
      tokens,
      created_at: customer.created_at,
      status: customer.status,
    });
  }
  if (customer.customerSearchTokensVersion !== CUSTOMER_SEARCH_TOKENS_VERSION) {
    await ctx.db.patch(customer._id, {
      customerSearchTokensVersion: CUSTOMER_SEARCH_TOKENS_VERSION,
    });
  }
}

/** Delete every token row of a customer (cascade delete paths). */
export async function deleteCustomerSearchTokens(
  ctx: { db: any },
  customerId: string,
) {
  const rows = (await ctx.db
    .query("customerSearchTokens")
    .withIndex("by_customer", (q: any) => q.eq("customer_id", customerId))
    .take(MAX_CUSTOMER_SEARCH_TOKENS + 1)) as CustomerSearchTokenDoc[];
  if (rows.length > MAX_CUSTOMER_SEARCH_TOKENS) {
    throw new Error(
      `Customer ${customerId} has more than ${MAX_CUSTOMER_SEARCH_TOKENS} search token rows`,
    );
  }
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

/** True once customers.backfillCustomerSearchTokens drained every legacy row. */
export async function customerSearchMigrationComplete(ctx: { db: any }) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) =>
      q.eq("key", CUSTOMER_SEARCH_MIGRATION_STATE_KEY),
    )
    .first();
  return state?.complete === true;
}

export async function markCustomerSearchMigrationComplete(ctx: { db: any }) {
  const state = await ctx.db
    .query("transitionState")
    .withIndex("by_key", (q: any) =>
      q.eq("key", CUSTOMER_SEARCH_MIGRATION_STATE_KEY),
    )
    .first();
  if (state) {
    await ctx.db.patch(state._id, { complete: true, cursor: null });
  } else {
    await ctx.db.insert("transitionState", {
      key: CUSTOMER_SEARCH_MIGRATION_STATE_KEY,
      complete: true,
    });
  }
}

/**
 * One bounded page of search results over the token stream: a single
 * page-sized paginated index read plus at most `limit` customer gets, in
 * deterministic newest-first order (created_at desc, _id desc — the index's
 * descending total order, so equal timestamps can never gap or duplicate
 * across pages). Under heavy post-filtering a page can be short or empty
 * while hasMore is true; the raw stream cursor never skips candidates.
 */
export async function searchCustomersPage(
  ctx: { db: any },
  args: {
    tokens: string[];
    status?: CustomerDoc["status"];
    limit: number;
    cursor: string | null;
  },
): Promise<{
  rows: CustomerDoc[];
  isDone: boolean;
  continueCursor: string | null;
}> {
  const [driveToken, ...restTokens] = args.tokens;
  const result = await ctx.db
    .query("customerSearchTokens")
    .withIndex("by_token_created", (q: any) => q.eq("token", driveToken))
    .order("desc")
    .paginate({ numItems: args.limit, cursor: args.cursor });
  const candidates = (result.page as CustomerSearchTokenDoc[]).filter(
    (row) =>
      (!args.status || row.status === args.status) &&
      restTokens.every((token) => row.tokens.includes(token)),
  );
  const rows: CustomerDoc[] = [];
  for (const candidate of candidates) {
    const customer = (await ctx.db.get(candidate.customer_id)) as CustomerDoc | null;
    if (!customer) continue;
    rows.push(customer);
  }
  return {
    rows,
    isDone: result.isDone,
    continueCursor: result.isDone ? null : (result.continueCursor ?? null),
  };
}
