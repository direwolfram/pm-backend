import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

async function insertCustomers(t: ReturnType<typeof convexTest>, count: number) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await t.run(async (ctx) => {
      for (let n = start; n < end; n += 1) {
        await ctx.db.insert("customers", {
          phone_country_code: "+63",
          phone_number: `93${String(n).padStart(8, "0")}`,
          status: n % 2 === 0 ? "active" : "guest",
          marketing_opt_in: false,
          order_count: 0,
          total_spend: 0,
          customerStatsVersion: 2,
          created_at: n,
          updated_at: n,
        });
      }
    });
  }
}

async function counterRow(t: ReturnType<typeof convexTest>, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("listCounts")
      .withIndex("by_scope_key", (q) =>
        q.eq("scope", "customers").eq("key", key),
      )
      .first(),
  );
}

describe("customers.list counter fallback bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never falls back to an unbounded count when counters are missing", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 600);

    // No counter rows exist: a full-range collect would be needed, so the
    // query fails explicitly instead.
    await expect(t.query(api.customers.list, { limit: 10 })).rejects.toThrow(
      /reconcileListCounts/,
    );

    // Reconcile (chunked, self-continuing) repairs the counters.
    let done = false;
    let cursor: string | undefined;
    let guard = 0;
    while (!done) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      const result = await t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "customers",
        cursor,
      });
      done = result.done === true;
      cursor = done ? undefined : (result as { nextCursor?: string }).nextCursor;
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(600);
    expect(page.totalIsExact).toBe(true);
    const active = await t.query(api.customers.list, { status: "active", limit: 10 });
    expect(active.total).toBe(300);
  });
});

describe("reconcileListCounts concurrency safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("supersedes an older in-flight run when a newer run starts", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 250); // two reconcile chunks (batch limit 200)

    // Run A starts and processes only its first chunk.
    const aFirst = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(aFirst.done).toBe(false);
    const aGeneration = aFirst.generation as number;

    // Run B starts mid-flight: A is now superseded.
    const bFirst = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(bFirst.generation).toBe(aGeneration + 1);

    // A's continuation aborts without touching counters.
    const aNext = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      cursor: (aFirst as { nextCursor?: string }).nextCursor,
      counts: (aFirst as { counts?: Record<string, number> }).counts,
      generation: aGeneration,
    });
    expect(aNext).toMatchObject({ superseded: true, done: false });
    expect(await counterRow(t, "all")).toBeNull();

    // B completes (chunk 2) and swaps in exact counters.
    const bNext = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      cursor: (bFirst as { nextCursor?: string }).nextCursor,
      counts: (bFirst as { counts?: Record<string, number> }).counts,
      generation: bFirst.generation,
    });
    expect(bNext.done).toBe(true);

    expect(await counterRow(t, "all")).toMatchObject({ count: 250 });
    expect(await counterRow(t, "status:active")).toMatchObject({ count: 125 });

    // A's scheduled continuation (if any) is also a harmless no-op.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await counterRow(t, "all")).toMatchObject({ count: 250 });
  });

  it("protects the final swap with a generation re-check", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 10);

    // Run A processes everything except the final swap.
    const aFirst = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(aFirst.done).toBe(true); // single chunk: A already swapped

    // Corrupt a counter, then start B while replaying A's stale final call.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("listCounts")
        .withIndex("by_scope_key", (q) =>
          q.eq("scope", "customers").eq("key", "all"),
        )
        .first();
      await ctx.db.patch(row!._id, { count: 999 });
    });
    const bFirst = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(bFirst.done).toBe(true);
    expect(await counterRow(t, "all")).toMatchObject({ count: 10 });

    // A duplicate of A's terminal call (same args, older generation) aborts.
    const aReplay = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      counts: {},
      generation: aFirst.generation,
    });
    expect(aReplay).toMatchObject({ superseded: true, done: false });
    expect(await counterRow(t, "all")).toMatchObject({ count: 10 });
  });

  it("manual continuations without a generation adopt the in-flight run", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 250);

    const first = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(first.done).toBe(false);

    // Legacy-style continuation: cursor + carried accumulator, no generation.
    const second = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      cursor: (first as { nextCursor?: string }).nextCursor,
      counts: (first as { counts?: Record<string, number> }).counts,
    });
    expect(second.done).toBe(true);
    expect((second as { restarted?: boolean }).restarted).toBeUndefined();
    expect(await counterRow(t, "all")).toMatchObject({ count: 250 });
  });
});

describe("reconcileListCounts preserves writes committed mid-run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts when customers are created between chunks and finishes exact", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 250); // two reconcile chunks

    const first = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(first.done).toBe(false);

    // Live writes land mid-scan (through the public mutation, which bumps
    // both the counters and the mutation generation).
    await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9999999901",
      status: "active",
    });
    await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9999999902",
      status: "guest",
    });

    // The next chunk finalizes, detects the generation change, and restarts.
    const second = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      cursor: (first as { nextCursor?: string }).nextCursor,
      counts: (first as { counts?: Record<string, number> }).counts,
      generation: first.generation,
      mutationGeneration: first.mutationGeneration,
      restarts: 0,
    });
    expect(second).toMatchObject({ done: false, restarted: true });

    // The restarted pass drains via its scheduled continuations.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await counterRow(t, "all")).toMatchObject({ count: 252 });
    expect(await counterRow(t, "status:active")).toMatchObject({ count: 126 });
    expect(await counterRow(t, "status:guest")).toMatchObject({ count: 126 });

    const page = await t.query(api.customers.list, { limit: 10 });
    expect(page.total).toBe(252);
    expect(page.totalIsExact).toBe(true);
  });

  it("restarts when a status change lands between chunks and keeps status counters exact", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 250); // 125 active, 125 guest
    const first = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
    });
    expect(first.done).toBe(false);

    // Flip one active customer to blocked mid-scan.
    const victim = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("customers")
        .withIndex("by_status_created", (q) => q.eq("status", "active"))
        .first();
      return row!._id;
    });
    await t.mutation(api.customers.setStatus, { id: victim, status: "blocked" });

    const second = await t.mutation(internal.listCounts.reconcileListCounts, {
      scope: "customers",
      cursor: (first as { nextCursor?: string }).nextCursor,
      counts: (first as { counts?: Record<string, number> }).counts,
      generation: first.generation,
      mutationGeneration: first.mutationGeneration,
      restarts: 0,
    });
    expect(second).toMatchObject({ done: false, restarted: true });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await counterRow(t, "all")).toMatchObject({ count: 250 });
    expect(await counterRow(t, "status:active")).toMatchObject({ count: 124 });
    expect(await counterRow(t, "status:guest")).toMatchObject({ count: 125 });
    expect(await counterRow(t, "status:blocked")).toMatchObject({ count: 1 });

    const blocked = await t.query(api.customers.list, { status: "blocked", limit: 10 });
    expect(blocked.total).toBe(1);
    expect(blocked.data[0]._id).toBe(victim);
  });

  it("fails explicitly after too many mid-scan restarts", async () => {
    const t = convexTest({ schema, modules });
    await insertCustomers(t, 10);

    await t.mutation(api.customers.create, {
      phone_country_code: "+63",
      phone_number: "9999999903",
    });

    await expect(
      t.mutation(internal.listCounts.reconcileListCounts, {
        scope: "customers",
        mutationGeneration: 0, // stale: a live write already bumped it
        restarts: 5,
      }),
    ).rejects.toThrow(/restarted 5 times/);
  });
});
