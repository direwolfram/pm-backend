import type { InventoryStatus } from "./model";

export function now(): number {
  return Date.now();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Mirrors the SQL check constraints + status semantics for inventory. */
export function deriveInventoryStatus(args: {
  quantityAvailable: number;
  lowStockThreshold: number;
  manualUnavailable?: boolean;
}): InventoryStatus {
  if (args.manualUnavailable) return "unavailable";
  if (args.quantityAvailable <= 0) return "out_of_stock";
  if (args.quantityAvailable <= args.lowStockThreshold) return "low_stock";
  return "in_stock";
}

/** Simple offset pagination for admin lists. */
export function paginate<T>(
  rows: T[],
  opts?: { limit?: number; offset?: number },
): { data: T[]; total: number; limit: number; offset: number } {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  return {
    data: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  };
}

export const MAX_PAGE_LIMIT = 200;
export const MAX_COMPAT_OFFSET = 200;

/**
 * Cursors are scoped to a query fingerprint (query name + filters + search
 * term). A continuation cursor is only valid for the exact query that
 * produced it; reusing it against a different filter set fails with a
 * predictable error instead of silently continuing a different query.
 */
export function cursorFingerprint(scope: Record<string, unknown>) {
  return JSON.stringify(scope, Object.keys(scope).sort());
}

export function wrapCursor(scope: Record<string, unknown>, cursor: string) {
  return JSON.stringify({ f: cursorFingerprint(scope), c: cursor });
}

export function unwrapCursor(
  scope: Record<string, unknown>,
  cursor?: string | null,
) {
  if (cursor === undefined || cursor === null) return null;
  let parsed: { f?: unknown; c?: unknown };
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error(
      "Invalid cursor: request a fresh first page without a cursor",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.c !== "string" ||
    parsed.f !== cursorFingerprint(scope)
  ) {
    throw new Error(
      "Invalid cursor: it does not match this query's filters or search term",
    );
  }
  return parsed.c;
}

export function boundedPageArgs(opts?: { limit?: number; offset?: number }) {
  const offset = Math.max(opts?.offset ?? 0, 0);
  if (offset > MAX_COMPAT_OFFSET) {
    throw new Error(
      `offset pagination is only supported up to ${MAX_COMPAT_OFFSET}; use cursor pagination for deeper pages`,
    );
  }
  return {
    limit: Math.min(Math.max(opts?.limit ?? 50, 1), MAX_PAGE_LIMIT),
    offset,
  };
}

export function pageResponse<T>(
  data: T[],
  args: { limit?: number; offset?: number; cursor?: string | null },
  pagination: {
    nextCursor?: string | null;
    continueCursor?: string | null;
    isDone?: boolean;
    total: number;
  },
) {
  const { limit, offset } = boundedPageArgs(args);
  const nextCursor = pagination.nextCursor ?? pagination.continueCursor ?? null;
  return {
    data,
    total: pagination.total,
    totalIsExact: true,
    limit,
    offset,
    cursor: nextCursor,
    nextCursor,
    hasMore: !(pagination.isDone ?? true),
  };
}

export function offsetCompatResponse<T>(
  rows: T[],
  args: { limit?: number; offset?: number },
) {
  const { limit, offset } = boundedPageArgs(args);
  const data = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;
  return pageResponse(data, args, {
    nextCursor: null,
    isDone: !hasMore,
    total: rows.length,
  });
}

export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function orderNumber(seq: number): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `PM-${ymd}-${String(seq).padStart(5, "0")}`;
}

export function assertNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
}

export function assertPositiveQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("quantity must be a positive finite number");
  }
}

export function assertPricePair(sale: number, compareAt?: number) {
  assertNonNegative(sale, "sale_price");
  if (compareAt !== undefined && compareAt < sale) {
    throw new Error("compare_at_price must be >= sale_price");
  }
}
