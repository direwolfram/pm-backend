import { useMutation, useQuery } from "convex/react";
import { api } from "@/lib/convexClient";

export function useInventory(sku?: string, centerId?: string) {
  const inventory = useQuery(
    api.quickInventory.getInventoryBySkuAndCenter,
    sku && centerId ? { sku, fulfillmentCenterId: centerId } : "skip",
  );

  return {
    inventory,
    stockLevel: inventory?.sellableQuantity ?? 0,
    loading: sku !== undefined && centerId !== undefined && inventory === undefined,
  };
}

export function useReserveItem() {
  return useMutation(api.quickInventory.reserveInventory);
}

export function useNearbyCenters(
  latitude?: number,
  longitude?: number,
  radiusKm = 5,
) {
  const centers = useQuery(
    api.quickInventory.getNearbyCenters,
    latitude !== undefined && longitude !== undefined
      ? { latitude, longitude, radiusKm }
      : "skip",
  );

  return { centers: centers ?? [], loading: centers === undefined };
}

export function useDeliverySlots(centerId: string | undefined, from: number) {
  const to = from + 24 * 60 * 60 * 1000;
  const slots = useQuery(
    api.quickInventory.getDeliverySlots,
    centerId ? { fulfillmentCenterId: centerId, from, to } : "skip",
  );

  return { slots: slots ?? [], loading: centerId !== undefined && slots === undefined };
}
