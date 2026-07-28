# Quick Inventory Backend

This adds Blinkit/Zepto-style inventory primitives on top of the existing PocketMart admin schema.

## Seed sample data

```bash
npx convex run quickInventorySeed:run
```

The seed creates 3 fulfillment centers, 20 products, 50 inventory rows, 10 perishable batches, delivery slots, and a sample user.

## Reservation flow

1. Find stock:

```bash
npx convex run quickInventory:getInventoryBySkuAndCenter '{"sku":"QCI-001","fulfillmentCenterId":"<center_id>"}'
```

2. Reserve stock for 10 minutes:

```bash
npx convex run quickInventory:reserveInventory '{"inventoryId":"<inventory_id>","quantity":1,"userId":"<user_id>"}'
```

3. Convert the reservation after checkout:

```bash
npx convex run quickInventory:convertReservation '{"reservationId":"<reservation_id>"}'
```

Stale active reservations are released by `convex/crons.ts` every minute.

## Low-stock consistency

`isLowStock` is maintained transactionally by quick inventory mutations that
change available or reserved quantities: reserve, release, conversion,
reservation expiry, manual adjustments, batch creation/expiry, and
replenishment. There is no periodic full-table replenishment refresh; callers
should mutate inventory through these functions so the stored flag remains
consistent with `availableQuantity - reservedQuantity <= replenishmentThreshold`.

## Assumptions

- External auth can map to the new `users` table or adapt calls to existing `customers`.
- Payment and dispatch systems should call `convertReservation` only after payment authorization.
- Delivery slot booking capacity should be incremented by checkout code that creates the order.
