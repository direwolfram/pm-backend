/**
 * Cursor-page state machine for admin lists backed by cursor-paginated
 * queries (products.listV2). Pure and framework-free so every navigation
 * behavior is unit-testable; the React wiring lives in useCursorPages.ts.
 *
 * Invariants:
 * - Every requested page and applied response is associated with the full
 *   filter/search fingerprint. Responses for another fingerprint, or for a
 *   cursor that was never requested, are ignored — stale pages can never mix
 *   into a new query.
 * - Reapplying an already-applied cursor replaces its rows in place, so
 *   reactive refetches and duplicate responses never duplicate rows.
 * - Post-filtered token-search pages may be empty while hasMore is true:
 *   empty pages auto-request their continuation (bounded by
 *   MAX_AUTO_CONTINUATIONS per gesture) so valid later matches stay
 *   reachable without manual paging. Continuation always advances the
 *   stream cursor, so it terminates at the end of the stream.
 * - "Exhausted" is only true once the final requested page reports
 *   hasMore === false; empty intermediate pages never look like the end.
 */

export const MAX_AUTO_CONTINUATIONS = 10;

export interface CursorPageState<T> {
  fingerprint: string;
  /** Requested page cursors in request order; the first page cursor is null. */
  requested: (string | null)[];
  /** Applied page rows keyed by cursor. */
  pages: Record<string, T[]>;
  hasMoreByCursor: Record<string, boolean>;
  nextCursorByCursor: Record<string, string | null>;
  /** Cursor the query should currently fetch. */
  activeCursor: string | null;
  /** Consecutive empty pages auto-continued since the last non-empty page. */
  autoContinuations: number;
}

export interface PageResponse<T> {
  fingerprint: string;
  cursor: string | null;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

function cursorKey(cursor: string | null) {
  return cursor === null ? "null" : cursor;
}

export function initialPageState<T>(fingerprint: string): CursorPageState<T> {
  return {
    fingerprint,
    requested: [null],
    pages: {},
    hasMoreByCursor: {},
    nextCursorByCursor: {},
    activeCursor: null,
    autoContinuations: 0,
  };
}

/**
 * Full reset on fingerprint change: accumulated pages, requested cursors,
 * active cursor, applied-result identity, and continuation bookkeeping all
 * return to a fresh first-page request.
 */
export function resetForFingerprint<T>(
  state: CursorPageState<T>,
  fingerprint: string,
): CursorPageState<T> {
  return state.fingerprint === fingerprint ? state : initialPageState<T>(fingerprint);
}

/**
 * Apply a query response. Ignored unless the response's fingerprint matches
 * the current one and its cursor was actually requested. Reapplication of
 * the same cursor (reactive refetch, stale duplicate) replaces rows without
 * side effects. A freshly applied empty page with hasMore auto-requests its
 * continuation, bounded by MAX_AUTO_CONTINUATIONS.
 */
export function applyPageResponse<T>(
  state: CursorPageState<T>,
  response: PageResponse<T>,
): CursorPageState<T> {
  if (response.fingerprint !== state.fingerprint) return state;
  if (!state.requested.some((cursor) => cursor === response.cursor)) return state;
  const key = cursorKey(response.cursor);
  const alreadyApplied = key in state.pages;
  let next: CursorPageState<T> = {
    ...state,
    pages: { ...state.pages, [key]: response.data },
    hasMoreByCursor: { ...state.hasMoreByCursor, [key]: response.hasMore },
    nextCursorByCursor: { ...state.nextCursorByCursor, [key]: response.nextCursor },
    autoContinuations:
      alreadyApplied || response.data.length > 0 ? 0 : state.autoContinuations,
  };
  if (alreadyApplied) return next;
  if (
    response.data.length === 0 &&
    response.hasMore &&
    response.nextCursor !== null &&
    !next.requested.some((cursor) => cursor === response.nextCursor) &&
    next.autoContinuations < MAX_AUTO_CONTINUATIONS
  ) {
    next = {
      ...next,
      requested: [...next.requested, response.nextCursor],
      activeCursor: response.nextCursor,
      autoContinuations: next.autoContinuations + 1,
    };
  }
  return next;
}

/**
 * Queue the next page for fetching (manual Load more). No-op for empty,
 * duplicate, or already-requested continuations — never a duplicate request.
 */
export function requestContinuation<T>(
  state: CursorPageState<T>,
  nextCursor: string | null,
): CursorPageState<T> {
  if (!nextCursor) return state;
  if (state.requested.some((cursor) => cursor === nextCursor)) {
    return state.activeCursor === nextCursor ? state : { ...state, activeCursor: nextCursor };
  }
  return {
    ...state,
    requested: [...state.requested, nextCursor],
    activeCursor: nextCursor,
  };
}

/** Flatten applied pages in request order. */
export function accumulatedRows<T>(state: CursorPageState<T>): T[] {
  return state.requested.flatMap((cursor) => state.pages[cursorKey(cursor)] ?? []);
}

/**
 * True only when the cursor stream is exhausted: the last requested page was
 * applied and reported hasMore === false. Empty intermediate pages with
 * hasMore === true are NOT exhausted — later pages may still hold matches.
 */
export function isExhausted<T>(state: CursorPageState<T>): boolean {
  const last = state.requested[state.requested.length - 1];
  const key = cursorKey(last);
  return key in state.pages && state.hasMoreByCursor[key] === false;
}

/** Continuation cursor of the most recently requested page, when applied. */
export function pendingContinuation<T>(state: CursorPageState<T>): string | null {
  const last = state.requested[state.requested.length - 1];
  const key = cursorKey(last);
  if (!(key in state.pages) || !state.hasMoreByCursor[key]) return null;
  return state.nextCursorByCursor[key] ?? null;
}
