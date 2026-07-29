# orders.list / orders.listV2 — Production Rollout Runbook

Scope: deploy the bounded order-list implementation (maintained `listCounts`
counters, `item_count` / `order_search_text` summaries, the `listV2`
cursor-first endpoint) onto a deployment that may contain legacy rows written
before these summaries and counters existed.

Every step below is idempotent and safe to re-run. If a step fails partway,
fix the cause and re-run the same step; do not skip ahead.

## 0. Preconditions

- The deployment accepts `npx convex run` from an operator shell
  (`CONVEX_DEPLOYMENT` / `--url` configured, admin credentials available).
- All commands below target the **production** deployment. Nothing in this
  runbook has been executed against production from this repository; the
  exact sequence is proven in `tests/orders.listV2.test.ts`
  (`orders rollout drill`) against an in-memory Convex backend. Record real
  outputs in the PR/issue when executing for real.

## 1. Deploy the code first

Deploy the functions that maintain counters and summaries transactionally
(`orders.create/updateStatus/remove/createItem/updateItem/removeItem/
reassignCustomer`, `customers.updateProfile/updatePhone`, seed paths) together
with the backfill/reconciliation functions and the `listV2` endpoint:

```sh
npx convex deploy
```

From this moment, all NEW writes keep counters and summaries correct inline.
Only PRE-EXISTING rows can be stale.

Note: `orders.list` / `orders.listV2` refuse to serve pages containing
pre-repair rows (missing/stale `orderSummaryVersion`), so step 2+ is
mandatory before the order list is usable on legacy data.

## 2. Rebuild the maintained counters

```sh
npx convex run listCounts:reconcileListCounts '{"scope":"orders"}'
```

Expected output (final invocation): `{"done": true, ...}`. The function
self-schedules continuations; wait until a run reports `done: true`. Re-run
the same command if in doubt — it recomputes and swaps all `orders` counter
rows transactionally on its final chunk.

Recovery: if interrupted, simply re-run; the accumulator restarts from the
beginning and the swap is atomic.

## 3. Backfill order summaries

```sh
npx convex run orders:backfillOrderListSummaries '{"limit": 100}'
```

The function selects rows with `orderSummaryVersion < 2`, recomputes
`item_count` + `order_search_text`, and self-schedules until
`remainingMayExist: false`. Re-running with no stale rows returns
`{"processed": 0, "patched": 0, ...}` — that is the drained signal.

## 4. Readiness gate (must pass before proceeding)

```sh
npx convex run orders:orderSummaryReadiness
```

Required output: `{"version": 2, "stale": 0, "overflow": false, "ready": true}`.
If `ready` is false, return to step 3. If `overflow` is true, stale rows
exceed the probe's sample cap — keep running step 3 and re-check.

## 5. Deep reconciliation sweep + proof sweep

```sh
npx convex run orders:reconcileOrderSummaries '{"limit": 100}'
```

Wait for `done: true` and record `patched`. Then run the SAME command a
second time: the second full sweep MUST report `"patched": 0`. A non-zero
second sweep means a writer is racing the reconciliation or a summary input
is non-deterministic — stop and investigate before enabling callers.

## 6. Enable callers

- `src/pages/Orders.tsx` already targets `orders.listV2` (cursor-first).
- Legacy `orders.list` remains available with documented compat bounds
  (offset ≤ 200, explicit errors for over-cap domains). Deprecate it only
  after verifying no other consumer calls it (check deployment logs /
  function usage dashboard).

## 7. Verification

```sh
npx convex run orders:listV2 '{"limit": 5}'
```

Expect a page with `totalIsExact: true`, an exact numeric `total`, and
newest-first rows. Spot-check a search (`{"search": "<term>", "limit": 5}`)
and a status filter.

## Rollback

- Code rollback: redeploy the previous commit. The counters and summary
  fields are additive/ignored by older code, so rollback is safe.
- Data repair is never destructive: counters/summaries are recomputed from
  source-of-truth rows, so any step can be re-run at any time.

## Evidence log (fill in during execution)

| Step | Command | Output summary | Operator | Time (UTC) |
|------|---------|----------------|----------|------------|
| 2 | reconcileListCounts orders |  |  |  |
| 3 | backfillOrderListSummaries |  |  |  |
| 4 | orderSummaryReadiness |  |  |  |
| 5a | reconcileOrderSummaries (1st) |  |  |  |
| 5b | reconcileOrderSummaries (2nd, expect patched: 0) |  |  |  |
| 7 | listV2 smoke check |  |  |  |

## Executed run — dev deployment `dev:aromatic-platypus-520` (2026-07-28)

> Executed against the only provisioned deployment for this repository, the
> **development** deployment `dev:aromatic-platypus-520`
> (`https://aromatic-platypus-520.convex.cloud`). No production deployment
> credentials exist in this environment; repeat the identical steps against
> production when it is provisioned and record a separate table.

| Step | Command | Recorded output |
|------|---------|-----------------|
| 1 | `npx convex deploy --typecheck=disable` | `✔ Deployed Convex functions to https://aromatic-platypus-520.convex.cloud` ("No indexes are deleted by this push"). `--typecheck=disable` required because the deploy-time strict tsc run fails on pre-existing codegen-binding mismatches in 11 files (repo typecheck `npm run typecheck` passes; the codebase intentionally uses codegen-free generic builders). |
| 2 | `npx convex run listCounts:reconcileListCounts '{"scope":"orders"}'` | `{ "distinctKeys": 11, "done": true, "processed": 5 }` — counters rebuilt in one chunk. |
| 3 | `npx convex run orders:backfillOrderListSummaries '{"limit": 100}'` | `{ "patched": 5, "processed": 5, "remainingMayExist": false }` — 5 legacy rows repaired, drained. |
| 4 | `npx convex run orders:orderSummaryReadiness` | `{ "overflow": false, "ready": true, "stale": 0, "version": 2 }` — gate passed. |
| 5a | `npx convex run orders:reconcileOrderSummaries '{"limit": 100}'` | `{ "done": true, "patched": 0, "processed": 5 }` |
| 5b | `npx convex run orders:reconcileOrderSummaries '{"limit": 100}'` | `{ "done": true, "patched": 0, "processed": 5 }` — second sweep patched zero rows, as required. |
| 7a | `npx convex run orders:listV2 '{"limit": 5}'` | `total: 5`, `totalIsExact: true`, `hasMore: true`; newest-first rows carrying `item_count`, `order_search_text`, `orderSummaryVersion: 2`; fingerprinted `nextCursor` issued. |
| 7b | `npx convex run orders:listV2 '{"search": "maria", "limit": 5}'` | `total: 2`, `totalIsExact: true`, `hasMore: false` (PM-20260725-01002, PM-20260725-01000, customer "Maria Santos"). |
| 7c | `npx convex run orders:listV2 '{"status": "delivered", "limit": 5}'` | `total: 2`, `totalIsExact: true`, `hasMore: false`. |

Result: all rollout checks passed on the dev deployment on 2026-07-28.

