export type TemperatureZone = "ambient" | "chilled" | "frozen";
export type FulfillmentZoneType = TemperatureZone | "general";
export type ReservationStatus = "active" | "converted" | "expired" | "released";
export type QualityCheckStatus = "pending" | "passed" | "failed";

export interface QuickInventoryRow {
  _id: string;
  sku?: string;
  productId?: string;
  fulfillmentCenterId?: string;
  availableQuantity?: number;
  reservedQuantity?: number;
  inboundQuantity?: number;
  maxOrderQuantity?: number;
  replenishmentThreshold?: number;
  expectedReplenishmentAt?: number;
  lastUpdatedAt?: number;
  isActive?: boolean;
  isLowStock?: boolean;
}

export interface SellableInventory extends QuickInventoryRow {
  sellableQuantity: number;
  isOutOfStock: boolean;
}
