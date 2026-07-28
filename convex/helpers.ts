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
  },
) {
  const { limit, offset } = boundedPageArgs(args);
  const nextCursor = pagination.nextCursor ?? pagination.continueCursor ?? null;
  return {
    data,
    total: undefined,
    totalIsExact: false,
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

export function assertPricePair(sale: number, compareAt?: number) {
  assertNonNegative(sale, "sale_price");
  if (compareAt !== undefined && compareAt < sale) {
    throw new Error("compare_at_price must be >= sale_price");
  }
}
