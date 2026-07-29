import { describe, expect, it } from "vitest";
import {
  accumulatedRows,
  applyPageResponse,
  initialPageState,
  isExhausted,
  MAX_AUTO_CONTINUATIONS,
  pendingContinuation,
  requestContinuation,
  resetForFingerprint,
  type CursorPageState,
} from "../src/lib/productPages";

type Row = { _id: string };

const FP = "s|all|all|all";

function rows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ _id: `${prefix}_${index}` }));
}

function page(
  state: CursorPageState<Row>,
  cursor: string | null,
  data: Row[],
  nextCursor: string | null,
  hasMore: boolean,
  fingerprint = FP,
) {
  return applyPageResponse(state, { fingerprint, cursor, data, nextCursor, hasMore });
}

describe("cursor page state machine", () => {
  it("reaches records beyond 200 through continuation", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 100), "cursor_1", true);
    state = requestContinuation(state, "cursor_1");
    state = page(state, "cursor_1", rows("page1", 100), "cursor_2", true);
    state = requestContinuation(state, "cursor_2");
    state = page(state, "cursor_2", rows("page2", 100), null, false);

    const all = accumulatedRows(state);
    expect(all).toHaveLength(300);
    expect(new Set(all.map((row) => row._id)).size).toBe(300);
    expect(all[0]._id).toBe("page0_0");
    expect(all[299]._id).toBe("page2_99");
    expect(isExhausted(state)).toBe(true);
  });

  it("auto-continues an empty first page with hasMore and applies the matching second page", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, [], "cursor_1", true);

    // Empty page is not the end: continuation was requested automatically.
    expect(isExhausted(state)).toBe(false);
    expect(state.activeCursor).toBe("cursor_1");
    expect(accumulatedRows(state)).toHaveLength(0);

    state = page(state, "cursor_1", rows("match", 3), null, false);
    expect(accumulatedRows(state).map((row) => row._id)).toEqual([
      "match_0",
      "match_1",
      "match_2",
    ]);
    expect(isExhausted(state)).toBe(true);
  });

  it("auto-continues several consecutive empty pages before a match", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, [], "cursor_1", true);
    state = page(state, "cursor_1", [], "cursor_2", true);
    state = page(state, "cursor_2", [], "cursor_3", true);
    expect(state.requested).toEqual([null, "cursor_1", "cursor_2", "cursor_3"]);
    expect(accumulatedRows(state)).toHaveLength(0);
    expect(isExhausted(state)).toBe(false);

    state = page(state, "cursor_3", rows("hit", 2), null, false);
    expect(accumulatedRows(state)).toHaveLength(2);
    expect(isExhausted(state)).toBe(true);
  });

  it("bounds auto-continuation and still allows manual load more", () => {
    let state = initialPageState<Row>(FP);
    let cursor: string | null = null;
    for (let index = 0; index < MAX_AUTO_CONTINUATIONS + 3; index += 1) {
      const next = `cursor_${index + 1}`;
      state = page(state, cursor, [], next, true);
      cursor = next;
    }
    // Auto-continuation stopped at the cap: further pages require a gesture.
    expect(state.requested).toHaveLength(MAX_AUTO_CONTINUATIONS + 1);
    expect(isExhausted(state)).toBe(false);
    expect(pendingContinuation(state)).toBe(`cursor_${MAX_AUTO_CONTINUATIONS + 1}`);

    state = requestContinuation(state, pendingContinuation(state));
    expect(state.activeCursor).toBe(`cursor_${MAX_AUTO_CONTINUATIONS + 1}`);
  });

  it("treats a fully exhausted no-match search as exhausted with zero rows", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, [], null, false);
    expect(accumulatedRows(state)).toHaveLength(0);
    expect(isExhausted(state)).toBe(true);
    expect(pendingContinuation(state)).toBeNull();
  });

  it("ignores responses from an old fingerprint after reset", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 100), "cursor_1", true);
    state = requestContinuation(state, "cursor_1");

    const reset = resetForFingerprint(state, "new|all|all|all");
    expect(reset.requested).toEqual([null]);
    expect(reset.activeCursor).toBeNull();
    expect(accumulatedRows(reset)).toHaveLength(0);

    // Stale in-flight response from the old fingerprint is dropped.
    const stale = page(reset, "cursor_1", rows("stale", 50), null, false, FP);
    expect(stale).toBe(reset);
    expect(accumulatedRows(stale)).toHaveLength(0);

    // Stale response for the first page of the old fingerprint is also dropped.
    const staleFirst = page(reset, null, rows("staleFirst", 50), null, false, FP);
    expect(accumulatedRows(staleFirst)).toHaveLength(0);
  });

  it("ignores responses for cursors that were never requested", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 10), "cursor_1", true);
    const next = page(state, "cursor_9", rows("bogus", 10), null, false);
    expect(next).toBe(state);
    expect(accumulatedRows(next)).toHaveLength(10);
  });

  it("reapplies pages idempotently so reactive refetches never duplicate rows", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 100), "cursor_1", true);
    state = requestContinuation(state, "cursor_1");
    state = page(state, "cursor_1", rows("page1", 100), null, false);

    // Reactive refetches replace in place.
    state = page(state, null, rows("page0", 100), "cursor_1", true);
    state = page(state, "cursor_1", rows("page1", 100), null, false);

    const all = accumulatedRows(state);
    expect(all).toHaveLength(200);
    expect(new Set(all.map((row) => row._id)).size).toBe(200);
  });

  it("does not queue duplicate or empty continuations", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 10), "cursor_1", true);
    state = requestContinuation(state, "cursor_1");
    state = requestContinuation(state, "cursor_1");
    expect(state.requested).toEqual([null, "cursor_1"]);
    expect(requestContinuation(state, null)).toBe(state);
  });

  it("reset on an unchanged fingerprint is a no-op", () => {
    let state = initialPageState<Row>(FP);
    state = page(state, null, rows("page0", 10), null, false);
    expect(resetForFingerprint(state, FP)).toBe(state);
  });
});
