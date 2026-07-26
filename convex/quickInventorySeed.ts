import { v } from "convex/values";
import { mutation } from "./functions";
import {
  computeSellable,
  isLowStock,
  pickPriorityScore,
  shelfLifeDaysRemaining,
} from "./lib/inventoryMath";
import { slugify } from "./helpers";
import type { Id as ConvexId } from "./_generated/dataModel";

interface SeedProduct {
  sku: string;
  name: string;
  categoryId: ConvexId<"categories">;
  brand: string;
  basePrice: number;
  temperatureZone: "ambient" | "chilled" | "frozen";
  packagingType: string;
  substituteSkuIds: string[];
  isFrequentlyBought: boolean;
  images: string[];
}

const dummyProductImages = [
  "F7C948",
  "90CDF4",
  "C6F6D5",
  "FBB6CE",
];

function dummyImagesForProduct(name: string) {
  return dummyProductImages.map((color, imageIndex) => {
    const label = imageIndex === 0 ? `${name} Showcase` : `${name} Slide ${imageIndex + 1}`;
    return `https://placehold.co/800x800/${color}/111827?text=${encodeURIComponent(label)}`;
  });
}

export const run = mutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("fulfillmentCenters").first();
    if (existing && !args.force) {
      return {
        seeded: false,
        message: "Quick inventory seed already exists. Pass { force: true } to add another sample set.",
      };
    }

    const t = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const userId = await ctx.db.insert("users", {
      name: "Sample quick-commerce user",
      email: `quick-user-${t}@example.com`,
      phone: "+639170000000",
      createdAt: t,
      updatedAt: t,
    });

    const categoryIds: ConvexId<"categories">[] = [];
    for (const [i, name] of [
      "Fresh produce",
      "Dairy",
      "Beverages",
      "Snacks",
      "Pantry",
    ].entries()) {
      const categoryId = await ctx.db.insert("categories", {
        name,
        slug: `${slugify(name)}-${t}`,
        sort_order: i,
        is_active: true,
      });
      categoryIds.push(categoryId);
    }

    const centers = [
      {
        name: "PocketMart Makati Dark Store",
        address: "Poblacion, Makati, Metro Manila",
        latitude: 14.5653,
        longitude: 121.0306,
        serviceablePincodes: ["1209", "1210", "1211"],
        coldChainEnabled: true,
      },
      {
        name: "PocketMart BGC Micro Hub",
        address: "Bonifacio Global City, Taguig",
        latitude: 14.551,
        longitude: 121.047,
        serviceablePincodes: ["1630", "1634", "1201"],
        coldChainEnabled: true,
      },
      {
        name: "PocketMart Quezon City Hub",
        address: "Batasan Hills, Quezon City",
        latitude: 14.676,
        longitude: 121.0437,
        serviceablePincodes: ["1100", "1126", "1127"],
        coldChainEnabled: false,
      },
    ];

    const centerIds: ConvexId<"fulfillmentCenters">[] = [];
    for (const center of centers) {
      const centerId = await ctx.db.insert("fulfillmentCenters", {
        ...center,
        zoneIds: [],
        isActive: true,
        operatingHours: { open: 6, close: 23 },
        capacity: 80,
      });
      const zoneIds = [];
      for (const [name, zoneType] of [
        ["Ambient Aisles", "ambient"],
        ["Cold Chain", "chilled"],
      ] as const) {
        const zoneId = await ctx.db.insert("zones", {
          fulfillmentCenterId: centerId,
          name,
          zoneType,
          pickLocations: [
            {
              binId: `${zoneType.toUpperCase()}-A-01`,
              aisle: "Aisle A",
              rack: "Rack 1",
              shelf: "Shelf 1",
              capacity: 120,
              currentCount: 0,
            },
          ],
        });
        zoneIds.push(zoneId);
      }
      await ctx.db.patch(centerId, { zoneIds });
      centerIds.push(centerId);
    }

    const products: SeedProduct[] = Array.from({ length: 20 }).map((_, index) => {
      const sku = `QCI-${String(index + 1).padStart(3, "0")}`;
      const categoryId = categoryIds[index % categoryIds.length]!;
      const chilled = index % 5 === 1;
      const frozen = index % 10 === 7;
      const name = [
        "Banana Lacatan",
        "Fresh Milk",
        "Sparkling Water",
        "Potato Chips",
        "Pancit Canton",
      ][index % 5]! + ` ${index + 1}`;
      return {
        sku,
        name,
        categoryId,
        brand: ["PocketMart", "Nestle", "Coca-Cola", "Jack n Jill"][index % 4]!,
        basePrice: 35 + index * 7,
        temperatureZone: frozen ? "frozen" : chilled ? "chilled" : "ambient",
        packagingType: chilled ? "carton" : frozen ? "pouch" : "pack",
        substituteSkuIds: [],
        isFrequentlyBought: index < 8,
        images: dummyImagesForProduct(name),
      };
    });
    for (const product of products) {
      product.substituteSkuIds = products
        .filter((candidate) => candidate.categoryId === product.categoryId && candidate.sku !== product.sku)
        .slice(0, 2)
        .map((candidate) => candidate.sku);
    }

    const productIds = new Map<string, ConvexId<"products">>();
    for (const [index, product] of products.entries()) {
      const productId = await ctx.db.insert("products", {
        sku: product.sku,
        brand: product.brand,
        categoryId: product.categoryId,
        primary_category_id: product.categoryId,
        name: product.name,
        slug: `${slugify(product.name)}-${t}`,
        description: `Quick-commerce sample SKU ${product.sku}`,
        status: "active",
        pack_type: product.packagingType,
        basePrice: product.basePrice,
        weightKg: 0.2 + index * 0.03,
        volumeL: 0.1 + index * 0.02,
        isFragile: index % 6 === 0,
        isFlammable: false,
        temperatureZone: product.temperatureZone,
        packagingType: product.packagingType,
        isFreshProduce: index % 5 === 0,
        isReturnable: index % 5 !== 0,
        searchKeywords: [product.name.toLowerCase(), product.sku.toLowerCase()],
        images: product.images,
        substituteSkuIds: product.substituteSkuIds,
        substitutePriority: index,
        allowSubstitution: product.substituteSkuIds.length > 0,
        isExpressAvailable: product.temperatureZone !== "frozen",
        isFrequentlyBought: product.isFrequentlyBought,
        rating_average: 0,
        rating_count: 0,
        attributes: [],
        created_at: t,
        updated_at: t,
      });
      for (const [mediaIndex, image] of product.images.entries()) {
        await ctx.db.insert("product_media", {
          product_id: productId,
          url: image,
          alt_text: `${product.name} image ${mediaIndex + 1}`,
          is_showcase: mediaIndex === 0,
          sort_order: mediaIndex,
        });
      }
      productIds.set(product.sku, productId);
    }

    const inventoryIds: ConvexId<"inventory">[] = [];
    let inventoryCount = 0;
    for (const [index, product] of products.entries()) {
      for (const [centerIndex, centerId] of centerIds.entries()) {
        if (inventoryCount >= 50) break;
        const availableQuantity = 10 + ((index + centerIndex) % 20);
        const reservedQuantity = centerIndex === 0 && index % 7 === 0 ? 2 : 0;
        const replenishmentThreshold = 6;
        const sellable = computeSellable(availableQuantity, reservedQuantity);
        const inventoryId = await ctx.db.insert("inventory", {
          sku: product.sku,
          productId: productIds.get(product.sku)!,
          fulfillmentCenterId: centerId,
          availableQuantity,
          reservedQuantity,
          inboundQuantity: index % 3 === 0 ? 12 : 0,
          maxOrderQuantity: 6,
          replenishmentThreshold,
          expectedReplenishmentAt: index % 4 === 0 ? t + 2 * 60 * 60 * 1000 : undefined,
          lastUpdatedAt: t,
          isActive: true,
          isLowStock: isLowStock(sellable, replenishmentThreshold),
        });
        inventoryIds.push(inventoryId);
        inventoryCount += 1;
      }
    }

    for (const [i, inventoryId] of inventoryIds.slice(0, 10).entries()) {
      const expiryDate = t + (i + 1) * day;
      const daysRemaining = shelfLifeDaysRemaining(expiryDate, t);
      await ctx.db.insert("batches", {
        inventoryId,
        batchNumber: `BATCH-${t}-${i + 1}`,
        quantity: 4 + i,
        expiryDate,
        manufacturedDate: t - 3 * day,
        harvestDate: i % 2 === 0 ? t - day : undefined,
        shelfLifeDaysRemaining: daysRemaining,
        isNearExpiry: daysRemaining <= 2,
        discountPercent: daysRemaining <= 2 ? 10 : 0,
        qualityCheckStatus: "passed",
        pickPriority: pickPriorityScore(expiryDate),
      });
    }

    for (const centerId of centerIds) {
      for (let i = 0; i < 12; i += 1) {
        const slotStart = t + i * 10 * 60 * 1000;
        await ctx.db.insert("deliverySlots", {
          fulfillmentCenterId: centerId,
          slotStart,
          slotEnd: slotStart + 10 * 60 * 1000,
          durationMinutes: 10,
          maxCapacity: 12,
          currentOrders: i % 4,
          isRushHour: i >= 5 && i <= 8,
          isAvailable: true,
        });
      }
    }

    return {
      seeded: true,
      userId,
      centers: centerIds.length,
      products: products.length,
      inventoryRows: inventoryIds.length,
      batches: 10,
    };
  },
});
