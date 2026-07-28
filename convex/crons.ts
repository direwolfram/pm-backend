import { anyApi, cronJobs } from "convex/server";

const crons = cronJobs();

crons.interval(
  "Expire stale cart reservations",
  { minutes: 1 },
  anyApi.quickInventory.expireCartReservations,
);

crons.interval(
  "Update batch shelf life",
  { hours: 6 },
  anyApi.quickInventory.updateShelfLife,
);

crons.daily(
  "Flag near-expiry markdowns",
  { hourUTC: 16, minuteUTC: 0 },
  anyApi.quickInventory.flagNearExpiry,
);

crons.interval(
  "Roll price activation/expiration transitions",
  { hours: 12 },
  anyApi.prices.scheduleTransition,
);

export default crons;
