import { useEffect, useState } from "react";
import {
  accumulatedRows,
  applyPageResponse,
  initialPageState,
  isExhausted,
  pendingContinuation,
  requestContinuation,
  resetForFingerprint,
  type CursorPageState,
} from "./productPages";

export interface CursorPageResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Effect-driven cursor pagination for a query whose args are fully described
 * by `fingerprint` (search/status/category/brand) plus the page cursor.
 *
 * - All state transitions happen in effects or event handlers — never during
 *   render.
 * - Reset (accumulated pages, cursors, applied identity, continuation state)
 *   fires whenever the fingerprint changes.
 * - A response is applied only when its render-time fingerprint still matches
 *   the accumulated state and its cursor was requested, so stale responses
 *   from an old filter/search fingerprint can never become the first page of
 *   a new query.
 * - Empty post-filtered pages with hasMore auto-continue via the state
 *   machine (see productPages.ts), keeping later matches reachable.
 */
export function useCursorPages<T, R extends CursorPageResult<T>>(
  fingerprint: string,
  usePageQuery: (cursor: string | null) => R | undefined,
): {
  rows: T[];
  result: R | undefined;
  exhausted: boolean;
  hasMore: boolean;
  awaitingPage: boolean;
  loadMore: () => void;
  state: CursorPageState<T>;
} {
  const [state, setState] = useState<CursorPageState<T>>(() =>
    initialPageState<T>(fingerprint),
  );
  // Derive the query cursor synchronously: on the first render after a
  // fingerprint change the state still holds the previous fingerprint and a
  // possibly deep activeCursor scoped to the OLD filters. Sending that
  // opaque cursor with the new filters would be an invalid-cursor request,
  // so a mismatched fingerprint always queries the first page (null).
  const queryCursor =
    state.fingerprint === fingerprint ? state.activeCursor : null;
  const result = usePageQuery(queryCursor);

  useEffect(() => {
    // Syncing the accumulator to a new filter/search fingerprint; the state
    // machine drops every page and cursor from the previous fingerprint.
    setState((current) => resetForFingerprint(current, fingerprint));
  }, [fingerprint]);

  useEffect(() => {
    if (!result) return;
    // Syncing an external query response into accumulator state. The cursor
    // is captured from the same render as the response, and the state
    // machine validates fingerprint and requested cursor, so stale or
    // duplicate responses are safe to apply.
    setState((current) =>
      applyPageResponse(current, {
        fingerprint,
        cursor: queryCursor,
        data: result.data,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      }),
    );
  }, [result, fingerprint, queryCursor]);

  const exhausted = isExhausted(state);
  const continuation = pendingContinuation(state);
  return {
    rows: accumulatedRows(state),
    result,
    exhausted,
    hasMore: continuation !== null,
    awaitingPage: result === undefined,
    loadMore: () => setState((current) => requestContinuation(current, continuation)),
    state,
  };
}
