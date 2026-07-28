import { describe, expect, it } from "vitest";
import {
  accumulatedRows,
  applyPage,
  emptyAccumulator,
  requestNextPage,
  resetAccumulator,
  type PageAccumulator,
} from "../src/lib/productPages";

type Row = { _id: string };

function pageRows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}_${index}`,
  }));
}

function loadFirstPage(state: PageAccumulator<Row>, rows: Row[], nextCursor: string | null) {
  let next = applyPage(state, state.activeCursor, rows);
  next = requestNextPage(next, nextCursor);
  return next;
}

describe("Products screen cursor pagination", () => {
  it("reaches records beyond the first 200 through load-more navigation", () => {
    let state = emptyAccumulator<Row>();
    state = loadFirstPage(state, pageRows("page0", 100), "cursor_1");
    expect(state.activeCursor).toBe("cursor_1");

    state = loadFirstPage(state, pageRows("page1", 100), "cursor_2");
    state = loadFirstPage(state, pageRows("page2", 100), null);

    const rows = accumulatedRows(state);
    expect(rows).toHaveLength(300);
    expect(new Set(rows.map((row) => row._id)).size).toBe(300);
    expect(rows[0]._id).toBe("page0_0");
    expect(rows[299]._id).toBe("page2_99");
    // No further page was queued once the stream ended.
    expect(state.activeCursor).toBe("cursor_2");
  });

  it("reapplies a page idempotently so stale or reactive responses never duplicate rows", () => {
    let state = emptyAccumulator<Row>();
    state = loadFirstPage(state, pageRows("page0", 100), "cursor_1");
    state = loadFirstPage(state, pageRows("page1", 100), null);

    // A reactive refetch of the first page replaces it in place.
    state = applyPage(state, null, pageRows("page0", 100));
    // A stale response for an already-applied cursor also replaces in place.
    state = applyPage(state, "cursor_1", pageRows("page1", 100));

    const rows = accumulatedRows(state);
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((row) => row._id)).size).toBe(200);
  });

  it("ignores responses for cursors that were never requested", () => {
    let state = emptyAccumulator<Row>();
    state = loadFirstPage(state, pageRows("page0", 100), "cursor_1");

    // Response from a different filter set arriving after reset is dropped.
    const afterReset = resetAccumulator<Row>();
    const mixed = applyPage(afterReset, "cursor_1", pageRows("stale", 100));
    expect(mixed).toBe(afterReset);
    expect(accumulatedRows(mixed)).toHaveLength(0);
    void state;
  });

  it("resets accumulated pages when search or filters change", () => {
    let state = emptyAccumulator<Row>();
    state = loadFirstPage(state, pageRows("page0", 100), "cursor_1");
    state = loadFirstPage(state, pageRows("page1", 100), null);
    expect(accumulatedRows(state)).toHaveLength(200);

    // Filter change: reset, then the fresh first page is the only content.
    state = resetAccumulator<Row>();
    state = loadFirstPage(state, pageRows("filtered", 3), null);
    const rows = accumulatedRows(state);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row._id)).toEqual(["filtered_0", "filtered_1", "filtered_2"]);
  });

  it("does not queue duplicate or empty continuations", () => {
    let state = emptyAccumulator<Row>();
    state = loadFirstPage(state, pageRows("page0", 100), null);
    expect(state.cursors).toEqual([null]);

    state = requestNextPage(state, "cursor_1");
    state = requestNextPage(state, "cursor_1");
    expect(state.cursors).toEqual([null, "cursor_1"]);
  });
});
