/**
 * Cursor-page accumulator for admin lists backed by cursor-paginated queries
 * (products.listV2). Kept pure and framework-free so the navigation behavior
 * is unit-testable: reaching records beyond the first page, idempotent page
 * application (stale or repeated responses never duplicate rows), and full
 * reset when filters or the search term change.
 */

export interface PageAccumulator<T> {
  /** Cursors of every requested page, in order; the first page cursor is null. */
  cursors: (string | null)[];
  /** Applied page data keyed by cursor ("null" for the first page). */
  pages: Record<string, T[]>;
  /** Cursor of the page the query should currently fetch. */
  activeCursor: string | null;
}

export function emptyAccumulator<T>(): PageAccumulator<T> {
  return { cursors: [null], pages: {}, activeCursor: null };
}

function cursorKey(cursor: string | null) {
  return cursor === null ? "null" : cursor;
}

/**
 * Record a fetched page. Idempotent per cursor: reapplying the same cursor
 * replaces its rows instead of appending, so reactive refetches and stale
 * responses can never duplicate or mix rows.
 */
export function applyPage<T>(
  state: PageAccumulator<T>,
  cursor: string | null,
  data: T[],
): PageAccumulator<T> {
  if (!state.cursors.some((entry) => entry === cursor)) return state;
  return { ...state, pages: { ...state.pages, [cursorKey(cursor)]: data } };
}

/** Queue the next page for fetching. No-op without a continuation cursor. */
export function requestNextPage<T>(
  state: PageAccumulator<T>,
  nextCursor: string | null,
): PageAccumulator<T> {
  if (!nextCursor) return state;
  if (state.cursors.some((entry) => entry === nextCursor)) {
    return { ...state, activeCursor: nextCursor };
  }
  return {
    cursors: [...state.cursors, nextCursor],
    pages: state.pages,
    activeCursor: nextCursor,
  };
}

/** Flatten applied pages in request order. */
export function accumulatedRows<T>(state: PageAccumulator<T>): T[] {
  return state.cursors.flatMap((cursor) => state.pages[cursorKey(cursor)] ?? []);
}

/** Drop every page and cursor (filter or search-term change). */
export function resetAccumulator<T>(): PageAccumulator<T> {
  return emptyAccumulator<T>();
}
