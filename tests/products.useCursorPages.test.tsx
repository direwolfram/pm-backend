// @vitest-environment jsdom
import React, { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCursorPages } from "../src/lib/useCursorPages";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { _id: string };
type Page = { data: Row[]; nextCursor: string | null; hasMore: boolean };

function cursorKey(cursor: string | null) {
  return cursor === null ? "null" : cursor;
}

/**
 * Controllable fake of the Convex query subscription: pages are keyed by
 * (fingerprint, cursor) and updates notify subscribed hooks, mimicking
 * reactive refetches and in-flight responses arriving late.
 */
function createQueryStore() {
  const listeners = new Set<() => void>();
  const data = new Map<string, Page>();
  let version = 0;
  return {
    set(fingerprint: string, cursor: string | null, page: Page) {
      data.set(`${fingerprint}|${cursorKey(cursor)}`, page);
      version += 1;
      for (const listener of listeners) listener();
    },
    usePage(fingerprint: string, cursor: string | null): Page | undefined {
      useSyncExternalStore(
        (onStoreChange) => {
          listeners.add(onStoreChange);
          return () => listeners.delete(onStoreChange);
        },
        () => version,
      );
      return data.get(`${fingerprint}|${cursorKey(cursor)}`);
    },
  };
}

type Store = ReturnType<typeof createQueryStore>;

function Harness({ fingerprint, store }: { fingerprint: string; store: Store }) {
  const paging = useCursorPages<Row, Page>(fingerprint, (cursor) =>
    store.usePage(fingerprint, cursor),
  );
  return (
    <div>
      <span data-testid="rows">{paging.rows.map((row) => row._id).join(",")}</span>
      <span data-testid="count">{paging.rows.length}</span>
      <span data-testid="exhausted">{String(paging.exhausted)}</span>
      <span data-testid="hasMore">{String(paging.hasMore)}</span>
      <button data-testid="loadMore" onClick={paging.loadMore}>
        more
      </button>
    </div>
  );
}

function rows(prefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ _id: `${prefix}_${index}` }));
}

const FP_A = "a|all|all|all";
const FP_B = "b|all|all|all";

describe("useCursorPages", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    // No state updates during render: React reports them via console.error.
    const renderPhaseUpdates = consoleError.mock.calls.filter((call) =>
      String(call[0]).match(/Cannot update .* while rendering|flushSync/i),
    );
    consoleError.mockRestore();
    expect(renderPhaseUpdates).toEqual([]);
  });

  it("auto-continues an empty first page and reaches the matching second page", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: [], nextCursor: "c1", hasMore: true });
    store.set(FP_A, "c1", { data: rows("match", 3), nextCursor: null, hasMore: false });

    render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));
    expect(screen.getByTestId("rows").textContent).toBe("match_0,match_1,match_2");
    expect(screen.getByTestId("exhausted").textContent).toBe("true");
  });

  it("auto-continues several consecutive empty pages before a match", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: [], nextCursor: "c1", hasMore: true });
    store.set(FP_A, "c1", { data: [], nextCursor: "c2", hasMore: true });
    store.set(FP_A, "c2", { data: [], nextCursor: "c3", hasMore: true });
    store.set(FP_A, "c3", { data: rows("hit", 2), nextCursor: null, hasMore: false });

    render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("exhausted").textContent).toBe("true");
  });

  it("ends exhausted with zero rows when the stream has no matches", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: [], nextCursor: null, hasMore: false });

    render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("exhausted").textContent).toBe("true"));
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("hasMore").textContent).toBe("false");
  });

  it("navigates beyond 200 products via load more", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: rows("page0", 100), nextCursor: "c1", hasMore: true });
    store.set(FP_A, "c1", { data: rows("page1", 100), nextCursor: "c2", hasMore: true });
    store.set(FP_A, "c2", { data: rows("page2", 100), nextCursor: null, hasMore: false });

    render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("100"));

    act(() => screen.getByTestId("loadMore").click());
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("200"));

    act(() => screen.getByTestId("loadMore").click());
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("300"));
    expect(screen.getByTestId("exhausted").textContent).toBe("true");
  });

  it("drops old-fingerprint pages on change and ignores the in-flight response", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: rows("a0", 100), nextCursor: "c1", hasMore: true });
    store.set(FP_B, null, { data: rows("b0", 5), nextCursor: null, hasMore: false });

    const { rerender } = render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("100"));

    act(() => screen.getByTestId("loadMore").click());
    // c1 is in flight (no response yet) when the fingerprint changes.
    rerender(<Harness fingerprint={FP_B} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("5"));
    expect(screen.getByTestId("rows").textContent).toBe("b0_0,b0_1,b0_2,b0_3,b0_4");

    // The stale old-fingerprint response finally arrives and must be ignored.
    act(() => store.set(FP_A, "c1", { data: rows("stale", 50), nextCursor: null, hasMore: false }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("5"));
    expect(screen.getByTestId("rows").textContent).toBe("b0_0,b0_1,b0_2,b0_3,b0_4");
    expect(screen.getByTestId("exhausted").textContent).toBe("true");
  });

  it("ignores a stale first-page refetch from the old fingerprint after reset", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: rows("a0", 10), nextCursor: null, hasMore: false });
    store.set(FP_B, null, { data: rows("b0", 2), nextCursor: null, hasMore: false });

    const { rerender } = render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("10"));

    rerender(<Harness fingerprint={FP_B} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));

    // A reactive refetch of the old fingerprint's first page re-fires.
    act(() => store.set(FP_A, null, { data: rows("stale", 7), nextCursor: null, hasMore: false }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByTestId("rows").textContent).toBe("b0_0,b0_1");
  });

  it("reapplies reactive refetches without duplicating rows", async () => {
    const store = createQueryStore();
    store.set(FP_A, null, { data: rows("page0", 100), nextCursor: "c1", hasMore: true });
    store.set(FP_A, "c1", { data: rows("page1", 100), nextCursor: null, hasMore: false });

    render(<Harness fingerprint={FP_A} store={store} />);
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("100"));

    act(() => screen.getByTestId("loadMore").click());
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("200"));

    // Reactive refetch of both pages with the same data.
    act(() => store.set(FP_A, null, { data: rows("page0", 100), nextCursor: "c1", hasMore: true }));
    act(() => store.set(FP_A, "c1", { data: rows("page1", 100), nextCursor: null, hasMore: false }));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("200"));

    const ids = screen.getByTestId("rows").textContent!.split(",");
    expect(new Set(ids).size).toBe(200);
  });
});
