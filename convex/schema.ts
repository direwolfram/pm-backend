import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * PocketMart quick-commerce schema — Convex port of schema.sql.
 *
 * Mapping notes:
 * - uuid PKs        -> Convex document ids (v.id("table") for foreign keys)
 * - timestamptz     -> v.number() (ms since epoch)
 * - numeric(12,2)   -> v.number() (PHP amounts, 2dp)
 * - jsonb           -> typed validators
 * - uuid[]          -> v.array(v.id("products"))
 * - tsvector search -> Convex search index on products
 * - check/unique    -> enforced inside mutations (see each module)
 */

const deliveryMode = v.union(
  v.literal("express"),
  v.literal("savers"),
  v.literal("sari-sari"),
);

export default defineSchema({
  /**
   * Transactionally maintained exact counts for admin list endpoints,
   * keyed by scope + filter dimension tuple. Lets list queries return an
   * exact numeric total for equality filter combinations with O(1) reads.
   * Drift (only possible via direct DB writes) is repaired by
   * listCounts.reconcileListCounts.
   */
  listCounts: defineTable({
    scope: v.string(),
    key: v.string(),
    count: v.number(),
  })
    .index("by_scope", ["scope"])
    .index("by_scope_key", ["scope", "key"]),

  /**
   * Singleton-style progress rows for background drains (e.g. the price
   * transition activation horizon).
   */
  transitionState: defineTable({
    key: v.string(),
    horizon: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    complete: v.optional(v.boolean()),
  }).index("by_key", ["key"]),

  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_phone", ["phone"]),

  customers: defineTable({
    phone_country_code: v.string(),
    phone_number: v.string(),
    display_name: v.optional(v.string()),
    email: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    status: v.union(
      v.literal("guest"),
      v.literal("active"),
      v.literal("blocked"),
      v.literal("deleted"),
    ),
    referral_code: v.optional(v.string()),
    marketing_opt_in: v.boolean(),
    search_text: v.optional(v.string()),
    order_count: v.optional(v.number()),
    total_spend: v.optional(v.number()),
    customerStatsVersion: v.optional(v.number()),
    statsGeneration: v.optional(v.number()),
    reconcile_cursor: v.optional(v.union(v.string(), v.null())),
    reconcile_generation: v.optional(v.number()),
    reconcile_totals: v.optional(
      v.object({ order_count: v.number(), total_spend: v.number() }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_phone", ["phone_country_code", "phone_number"])
    .index("by_status", ["status"])
    .index("by_referral_code", ["referral_code"])
    .index("by_created", ["created_at"])
    .index("by_status_created", ["status", "created_at"])
    .index("by_customer_stats_version", ["customerStatsVersion"])
    .searchIndex("search_customers", {
      searchField: "search_text",
      filterFields: ["status"],
    }),

  otp_challenges: defineTable({
    phone_country_code: v.string(),
    phone_number: v.string(),
    channel: v.union(v.literal("sms"), v.literal("whatsapp")),
    code_hash: v.string(),
    expires_at: v.number(),
    attempts: v.number(),
    consumed_at: v.optional(v.number()),
    created_at: v.number(),
  }).index("by_phone", ["phone_country_code", "phone_number"]),

  customer_settings: defineTable({
    customer_id: v.id("customers"),
    theme: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
    preferred_delivery_mode: deliveryMode,
    push_notifications_enabled: v.boolean(),
    sms_notifications_enabled: v.boolean(),
    whatsapp_notifications_enabled: v.boolean(),
    updated_at: v.number(),
  }).index("by_customer", ["customer_id"]),

  addresses: defineTable({
    customer_id: v.id("customers"),
    label: v.union(
      v.literal("home"),
      v.literal("work"),
      v.literal("school"),
      v.literal("other"),
    ),
    title: v.string(),
    full_address: v.string(),
    street: v.optional(v.string()),
    barangay: v.optional(v.string()),
    city: v.optional(v.string()),
    province: v.optional(v.string()),
    postal_code: v.optional(v.string()),
    country_code: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    delivery_notes: v.optional(v.string()),
    is_default: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_customer", ["customer_id"]),

  stores: defineTable({
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("inactive")),
    address: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    timezone: v.string(),
    deleting_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_status", ["status"]),

  delivery_zones: defineTable({
    store_id: v.id("stores"),
    name: v.string(),
    delivery_mode: deliveryMode,
    min_order_amount: v.number(),
    delivery_fee_amount: v.number(),
    currency: v.string(),
    estimated_minutes_min: v.number(),
    estimated_minutes_max: v.number(),
    is_active: v.boolean(),
  }).index("by_store", ["store_id"]),

  brands: defineTable({
    name: v.string(),
    logo_url: v.optional(v.string()),
    logo_color: v.optional(v.string()),
    is_active: v.boolean(),
    deleting_at: v.optional(v.number()),
  }).index("by_name", ["name"]),

  categories: defineTable({
    parent_id: v.optional(v.id("categories")),
    name: v.string(),
    slug: v.string(),
    section_name: v.optional(v.string()),
    image_url: v.optional(v.string()),
    icon_emoji: v.optional(v.string()),
    background_color: v.optional(v.string()),
    image_color: v.optional(v.string()),
    sort_order: v.number(),
    is_active: v.boolean(),
    deleting_at: v.optional(v.number()),
  })
    .index("by_parent", ["parent_id"])
    .index("by_slug", ["slug"]),

  products: defineTable({
    sku: v.optional(v.string()),
    brand_id: v.optional(v.id("brands")),
    categoryId: v.optional(v.id("categories")),
    primary_category_id: v.id("categories"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("hidden"),
      v.literal("discontinued"),
    ),
    tag: v.optional(v.string()),
    pack_type: v.optional(v.string()),
    brand: v.optional(v.string()),
    basePrice: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    volumeL: v.optional(v.number()),
    isFragile: v.optional(v.boolean()),
    isFlammable: v.optional(v.boolean()),
    temperatureZone: v.optional(
      v.union(v.literal("ambient"), v.literal("chilled"), v.literal("frozen")),
    ),
    packagingType: v.optional(v.string()),
    isFreshProduce: v.optional(v.boolean()),
    isReturnable: v.optional(v.boolean()),
    searchKeywords: v.optional(v.array(v.string())),
    images: v.optional(v.array(v.string())),
    substituteSkuIds: v.optional(v.array(v.string())),
    substitutePriority: v.optional(v.number()),
    allowSubstitution: v.optional(v.boolean()),
    isExpressAvailable: v.optional(v.boolean()),
    isFrequentlyBought: v.optional(v.boolean()),
    shelf_life: v.optional(v.string()),
    flavour: v.optional(v.string()),
    finish: v.optional(v.string()),
    paraben_free: v.optional(v.boolean()),
    colour_family: v.optional(v.string()),
    badge_text: v.optional(v.string()),
    icon_emoji: v.optional(v.string()),
    image_color: v.optional(v.string()),
    rating_average: v.number(),
    rating_count: v.number(),
    sku_count: v.optional(v.number()),
    default_sku_id: v.optional(v.id("skus")),
    default_price: v.optional(v.number()),
    total_stock: v.optional(v.number()),
    productListSummaryVersion: v.optional(v.number()),
    productSearchTokensVersion: v.optional(v.number()),
    deleting_at: v.optional(v.number()),
    attributes: v.array(
      v.object({ key: v.string(), label: v.string(), value: v.string() }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_sku", ["sku"])
    .index("by_category", ["primary_category_id"])
    .index("by_category_id", ["categoryId"])
    .index("by_brand", ["brand_id"])
    .index("by_brand_name", ["brand"])
    .index("by_frequently_bought", ["isFrequentlyBought"])
    .index("by_slug", ["slug"])
    .index("by_status", ["status"])
    .index("by_updated", ["updated_at"])
    .index("by_status_updated", ["status", "updated_at"])
    .index("by_category_updated", ["primary_category_id", "updated_at"])
    .index("by_brand_updated", ["brand_id", "updated_at"])
    .index("by_category_status_updated", [
      "primary_category_id",
      "status",
      "updated_at",
    ])
    .index("by_brand_status_updated", ["brand_id", "status", "updated_at"])
    .index("by_category_brand_updated", [
      "primary_category_id",
      "brand_id",
      "updated_at",
    ])
    .index("by_category_brand_status_updated", [
      "primary_category_id",
      "brand_id",
      "status",
      "updated_at",
    ])
    .index("by_product_list_summary_version", ["productListSummaryVersion"])
    .index("by_product_search_tokens_version", ["productSearchTokensVersion"])
    .searchIndex("search_products", {
      searchField: "name",
      filterFields: ["status", "primary_category_id", "brand_id"],
    }),

  /**
   * Tokenized product-name search rows. Convex search indexes cannot be
   * paginated, so genuine cursor-paginated search runs over this table: one
   * row per (product, name token), driven by the by_token_updated index
   * (newest-first) with page-bounded chunk reads. Written transactionally by
   * products.create / products.update / cascade deletes; legacy rows are
   * backfilled by products.backfillProductSearchTokens, which records its
   * completion in transitionState under key "productSearchTokens".
   */
  productSearchTokens: defineTable({
    product_id: v.id("products"),
    token: v.string(),
    tokens: v.array(v.string()),
    updated_at: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("hidden"),
      v.literal("discontinued"),
    ),
    primary_category_id: v.id("categories"),
    brand_id: v.optional(v.id("brands")),
  })
    .index("by_token_updated", ["token", "updated_at"])
    .index("by_product", ["product_id"]),

  product_media: defineTable({
    product_id: v.id("products"),
    url: v.string(),
    storage_id: v.optional(v.id("_storage")),
    alt_text: v.optional(v.string()),
    dominant_color: v.optional(v.string()),
    is_showcase: v.optional(v.boolean()),
    sort_order: v.number(),
  }).index("by_product", ["product_id"]),

  product_similar_products: defineTable({
    product_id: v.id("products"),
    similar_product_id: v.id("products"),
  })
    .index("by_product", ["product_id"])
    .index("by_similar_product", ["similar_product_id"])
    .index("by_pair", ["product_id", "similar_product_id"]),

  skus: defineTable({
    product_id: v.id("products"),
    sku_code: v.string(),
    barcode: v.optional(v.string()),
    display_name: v.optional(v.string()),
    variant_label: v.string(),
    pack_size: v.optional(v.string()),
    unit_of_measure: v.optional(v.string()),
    shade_name: v.optional(v.string()),
    shade_color: v.optional(v.string()),
    image_color: v.optional(v.string()),
    badge_text: v.optional(v.string()),
    sort_order: v.number(),
    is_default: v.boolean(),
    is_active: v.boolean(),
    deleting_at: v.optional(v.number()),
  })
    .index("by_product", ["product_id"])
    .index("by_sku_code", ["sku_code"])
    .index("by_barcode", ["barcode"]),

  prices: defineTable({
    sku_id: v.id("skus"),
    product_id: v.optional(v.id("products")),
    store_id: v.optional(v.id("stores")),
    storeName: v.optional(v.string()),
    currency: v.string(),
    sale_price: v.number(),
    compare_at_price: v.optional(v.number()),
    starts_at: v.number(),
    ends_at: v.optional(v.number()),
    priceSummaryVersion: v.optional(v.number()),
  })
    .index("by_sku", ["sku_id"])
    .index("by_product", ["product_id"])
    .index("by_sku_starts", ["sku_id", "starts_at"])
    .index("by_sku_store", ["sku_id", "store_id"])
    .index("by_store", ["store_id"])
    .index("by_starts_at", ["starts_at"])
    .index("by_price_summary_version", ["priceSummaryVersion"]),

  /**
   * Persisted next-transition records for prices with a future starts_at:
   * one row at starts_at - PRICE_ACTIVE_LOOKAHEAD_MS (materialize the mirror
   * before activation) and one at starts_at (refresh stored summaries).
   * prices.scheduleTransition drains rows with due_at <= now in bounded
   * batches, so a price created days or months before its activation is
   * always materialized on time without rescanning price history.
   * Written transactionally by prices.upsert and every price-deletion path
   * cleans it up; prices.backfillPriceTransitions journals legacy rows.
   */
  priceTransitions: defineTable({
    price_id: v.id("prices"),
    due_at: v.number(),
  })
    .index("by_due", ["due_at"])
    .index("by_price", ["price_id"]),

  /**
   * Persisted materialization of the price set that is currently active or
   * scheduled to activate within PRICE_ACTIVE_LOOKAHEAD_MS, per SKU. Lets the
   * product list select the correct active price with a bounded read instead
   * of scanning unbounded historical prices. Maintained transactionally by
   * prices.upsert / prices.remove / prices.scheduleTransition.
   */
  pricesActive: defineTable({
    sku_id: v.id("skus"),
    price_id: v.id("prices"),
    product_id: v.optional(v.id("products")),
    store_id: v.optional(v.id("stores")),
    sale_price: v.number(),
    starts_at: v.number(),
    ends_at: v.optional(v.number()),
  })
    .index("by_sku", ["sku_id"])
    .index("by_ends_at", ["ends_at"]),

  inventory: defineTable({
    sku_id: v.optional(v.id("skus")),
    store_id: v.optional(v.id("stores")),
    quantity_available: v.optional(v.number()),
    quantity_reserved: v.optional(v.number()),
    low_stock_threshold: v.optional(v.number()),
    status: v.optional(v.union(
      v.literal("in_stock"),
      v.literal("low_stock"),
      v.literal("out_of_stock"),
      v.literal("unavailable"),
    )),
    restock_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    skuCode: v.optional(v.string()),
    variantLabel: v.optional(v.string()),
    storeName: v.optional(v.string()),
    storeInventorySummaryVersion: v.optional(v.number()),

    sku: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    fulfillmentCenterId: v.optional(v.id("fulfillmentCenters")),
    availableQuantity: v.optional(v.number()),
    reservedQuantity: v.optional(v.number()),
    inboundQuantity: v.optional(v.number()),
    maxOrderQuantity: v.optional(v.number()),
    replenishmentThreshold: v.optional(v.number()),
    expectedReplenishmentAt: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    isLowStock: v.optional(v.boolean()),
    isQuickInventory: v.optional(v.boolean()),
    quickStatus: v.optional(v.union(
      v.literal("in_stock"),
      v.literal("low_stock"),
      v.literal("out_of_stock"),
      v.literal("unavailable"),
    )),
    productName: v.optional(v.string()),
    productBrand: v.optional(v.string()),
    fulfillmentCenterName: v.optional(v.string()),
    pricingSummary: v.optional(v.object({
      _id: v.id("inventoryPricing"),
      _creationTime: v.optional(v.number()),
      inventoryId: v.id("inventory"),
      dynamicPrice: v.number(),
      flashSaleReservedQty: v.number(),
      membershipExclusiveQty: v.number(),
      discountStartAt: v.optional(v.number()),
      discountEndAt: v.optional(v.number()),
      isSurgeActive: v.boolean(),
    })),
    batchCount: v.optional(v.number()),
    nearExpiryBatchCount: v.optional(v.number()),
    earliestExpiryDate: v.optional(v.number()),
    quickInventorySummaryVersion: v.optional(v.number()),
  })
    .index("by_sku_store", ["sku_id", "store_id"])
    .index("by_store", ["store_id"])
    .index("by_store_status", ["store_id", "status"])
    .index("by_store_inventory_summary_version", ["storeInventorySummaryVersion"])
    .index("by_status_quantity", ["status", "quantity_available"])
    .index("by_sku", ["sku_id"])
    .index("by_product_id", ["productId"])
    .index("by_sku_center", ["sku", "fulfillmentCenterId"])
    .index("by_center_active", ["fulfillmentCenterId", "isActive"])
    .index("by_quick_inventory", ["isQuickInventory"])
    .index("by_quick_status", ["quickStatus"])
    .index("by_center_quick_status", ["fulfillmentCenterId", "quickStatus"])
    .index("by_low_stock", ["fulfillmentCenterId", "isLowStock"])
    .index("by_summary_version", ["quickInventorySummaryVersion"])
    .index("by_last_updated", ["lastUpdatedAt"]),

  fulfillmentCenters: defineTable({
    name: v.string(),
    address: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    serviceablePincodes: v.array(v.string()),
    zoneIds: v.array(v.id("zones")),
    isActive: v.boolean(),
    operatingHours: v.object({ open: v.number(), close: v.number() }),
    capacity: v.number(),
    coldChainEnabled: v.boolean(),
  })
    .index("by_pincode", ["serviceablePincodes"])
    .index("by_location", ["latitude", "longitude"])
    .index("by_active", ["isActive"]),

  zones: defineTable({
    fulfillmentCenterId: v.id("fulfillmentCenters"),
    name: v.string(),
    zoneType: v.union(
      v.literal("ambient"),
      v.literal("chilled"),
      v.literal("frozen"),
      v.literal("general"),
    ),
    pickLocations: v.array(
      v.object({
        binId: v.string(),
        aisle: v.string(),
        rack: v.string(),
        shelf: v.string(),
        capacity: v.number(),
        currentCount: v.number(),
      }),
    ),
  }).index("by_center", ["fulfillmentCenterId"]),

  batches: defineTable({
    inventoryId: v.id("inventory"),
    batchNumber: v.string(),
    quantity: v.number(),
    expiryDate: v.number(),
    manufacturedDate: v.optional(v.number()),
    harvestDate: v.optional(v.number()),
    shelfLifeDaysRemaining: v.number(),
    isNearExpiry: v.boolean(),
    discountPercent: v.number(),
    qualityCheckStatus: v.union(
      v.literal("pending"),
      v.literal("passed"),
      v.literal("failed"),
    ),
    pickPriority: v.number(),
    expiredAt: v.optional(v.number()),
    nextShelfLifeRefreshAt: v.optional(v.number()),
  })
    .index("by_inventory_expiry", ["inventoryId", "expiryDate"])
    .index("by_near_expiry", ["isNearExpiry"])
    .index("by_expiry", ["expiryDate"])
    .index("by_unexpired_expiry", ["expiredAt", "expiryDate"])
    .index("by_shelf_life_due", ["nextShelfLifeRefreshAt", "expiryDate"])
    .index("by_unexpired_shelf_life_due", [
      "expiredAt",
      "nextShelfLifeRefreshAt",
      "expiryDate",
    ]),

  deliverySlots: defineTable({
    fulfillmentCenterId: v.id("fulfillmentCenters"),
    slotStart: v.number(),
    slotEnd: v.number(),
    durationMinutes: v.number(),
    maxCapacity: v.number(),
    currentOrders: v.number(),
    isRushHour: v.boolean(),
    isAvailable: v.boolean(),
  })
    .index("by_center_time", ["fulfillmentCenterId", "slotStart"])
    .index("by_center_available", ["fulfillmentCenterId", "isAvailable"]),

  cartReservations: defineTable({
    userId: v.id("users"),
    inventoryId: v.id("inventory"),
    quantity: v.number(),
    reservedAt: v.number(),
    expiresAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("converted"),
      v.literal("expired"),
      v.literal("released"),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_inventory", ["inventoryId"]),

  inventoryPricing: defineTable({
    inventoryId: v.id("inventory"),
    dynamicPrice: v.number(),
    flashSaleReservedQty: v.number(),
    membershipExclusiveQty: v.number(),
    discountStartAt: v.optional(v.number()),
    discountEndAt: v.optional(v.number()),
    isSurgeActive: v.boolean(),
  }).index("by_inventory", ["inventoryId"]),

  inventoryLogs: defineTable({
    inventoryId: v.id("inventory"),
    adjustment: v.number(),
    reason: v.string(),
    previousAvailableQuantity: v.number(),
    nextAvailableQuantity: v.number(),
    createdAt: v.number(),
  })
    .index("by_inventory", ["inventoryId"])
    .index("by_created", ["createdAt"]),

  promotions: defineTable({
    kind: v.union(
      v.literal("banner"),
      v.literal("carousel"),
      v.literal("coupon"),
      v.literal("product_discount"),
    ),
    title: v.string(),
    subtitle: v.optional(v.string()),
    description: v.optional(v.string()),
    image_url: v.optional(v.string()),
    background_color: v.optional(v.string()),
    discount_type: v.optional(
      v.union(
        v.literal("percent"),
        v.literal("fixed"),
        v.literal("free_delivery"),
      ),
    ),
    discount_value: v.optional(v.number()),
    coupon_code: v.optional(v.string()),
    minimum_order_amount: v.optional(v.number()),
    max_discount_amount: v.optional(v.number()),
    currency: v.string(),
    starts_at: v.number(),
    ends_at: v.number(),
    is_active: v.boolean(),
    deleting_at: v.optional(v.number()),
  })
    .index("by_coupon_code", ["coupon_code"])
    .index("by_kind", ["kind"])
    .index("by_active", ["is_active"]),

  promotion_targets: defineTable({
    promotion_id: v.id("promotions"),
    product_id: v.optional(v.id("products")),
    sku_id: v.optional(v.id("skus")),
    category_id: v.optional(v.id("categories")),
    brand_id: v.optional(v.id("brands")),
  })
    .index("by_promotion", ["promotion_id"])
    .index("by_product", ["product_id"])
    .index("by_sku", ["sku_id"])
    .index("by_category", ["category_id"])
    .index("by_brand", ["brand_id"]),

  home_sections: defineTable({
    id: v.optional(v.string()),
    key: v.optional(v.string()),
    kind: v.union(
      v.literal("header"),
      v.literal("search_bar"),
      v.literal("category_tabs"),
      v.literal("hero_banner"),
      v.literal("bestseller_grid"),
      v.literal("promo_banner"),
      v.literal("promo_carousel"),
      v.literal("shopping_list_card"),
      v.literal("category_grid"),
      v.literal("themed_product_section"),
      v.literal("product_carousel"),
      v.literal("featured_products"),
      v.literal("store_inventory_section"),
      v.literal("custom_cta"),
      v.literal("spacer"),
    ),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    tab: v.string(),
    sortOrder: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    allowEmpty: v.optional(v.boolean()),
    startsAt: v.optional(v.number()),
    endsAt: v.optional(v.number()),
    timezone: v.optional(v.string()),
    visibleDaysOfWeek: v.optional(v.array(v.number())),
    visibleTimeWindows: v.optional(
      v.array(v.object({ start: v.string(), end: v.string() })),
    ),
    holidayTags: v.optional(v.array(v.string())),
    seasonalTags: v.optional(v.array(v.string())),
    storeIds: v.optional(v.array(v.id("stores"))),
    cityIds: v.optional(v.array(v.string())),
    regionIds: v.optional(v.array(v.string())),
    customerSegments: v.optional(v.array(v.string())),
    appVersion: v.optional(v.string()),
    minAppVersion: v.optional(v.string()),
    maxAppVersion: v.optional(v.string()),
    layoutVariant: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    backgroundImage: v.optional(v.string()),
    backgroundImageStorageId: v.optional(v.id("_storage")),
    textColor: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    storageId: v.optional(v.id("_storage")),
    iconEmoji: v.optional(v.string()),
    maxItems: v.optional(v.number()),
    productIds: v.optional(v.array(v.id("products"))),
    categoryIds: v.optional(v.array(v.id("categories"))),
    promotionIds: v.optional(v.array(v.id("promotions"))),
    brandIds: v.optional(v.array(v.id("brands"))),
    config: v.optional(v.any()),
    resolvedData: v.optional(v.any()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),

    // Legacy fields retained so existing seeded databases keep validating
    // until they are migrated by homeSections.seedDefaults or admin edits.
    sort_order: v.optional(v.number()),
    is_active: v.optional(v.boolean()),
  })
    .index("by_key", ["key"])
    .index("by_tab", ["tab", "sortOrder"]),

  home_tab_layouts: defineTable({
    tab: v.string(),
    overrideEnabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_tab", ["tab"]),

  home_section_items: defineTable({
    section_id: v.id("home_sections"),
    product_id: v.optional(v.id("products")),
    category_id: v.optional(v.id("categories")),
    promotion_id: v.optional(v.id("promotions")),
    sort_order: v.number(),
  })
    .index("by_section", ["section_id"])
    .index("by_product", ["product_id"])
    .index("by_category", ["category_id"])
    .index("by_promotion", ["promotion_id"]),

  carts: defineTable({
    customer_id: v.optional(v.id("customers")),
    anonymous_id: v.optional(v.string()),
    store_id: v.optional(v.id("stores")),
    status: v.union(
      v.literal("active"),
      v.literal("ordered"),
      v.literal("abandoned"),
    ),
    currency: v.string(),
    subtotal_amount: v.number(),
    discount_amount: v.number(),
    delivery_fee_amount: v.number(),
    total_amount: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_customer", ["customer_id"])
    .index("by_anonymous", ["anonymous_id"])
    .index("by_status", ["status"]),

  cart_items: defineTable({
    cart_id: v.id("carts"),
    sku_id: v.id("skus"),
    product_id: v.id("products"),
    quantity: v.number(),
    unit_price: v.number(),
    compare_at_price: v.optional(v.number()),
    line_total: v.number(),
    added_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_cart", ["cart_id"])
    .index("by_cart_sku", ["cart_id", "sku_id"]),

  shopping_lists: defineTable({
    customer_id: v.optional(v.id("customers")),
    anonymous_id: v.optional(v.string()),
    name: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_customer", ["customer_id"])
    .index("by_anonymous", ["anonymous_id"]),

  shopping_list_items: defineTable({
    shopping_list_id: v.id("shopping_lists"),
    raw_text: v.string(),
    normalized_query: v.string(),
    matched_product_ids: v.array(v.id("products")),
    sort_order: v.number(),
    is_completed: v.boolean(),
  }).index("by_list", ["shopping_list_id"]),

  orders: defineTable({
    order_number: v.string(),
    customer_id: v.id("customers"),
    cart_id: v.optional(v.id("carts")),
    store_id: v.id("stores"),
    address_id: v.id("addresses"),
    delivery_mode: deliveryMode,
    status: v.union(
      v.literal("pending_payment"),
      v.literal("confirmed"),
      v.literal("picking"),
      v.literal("packed"),
      v.literal("out_for_delivery"),
      v.literal("delivered"),
      v.literal("cancelled"),
      v.literal("refunded"),
    ),
    payment_status: v.union(
      v.literal("pending"),
      v.literal("authorized"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("refunded"),
    ),
    currency: v.string(),
    subtotal_amount: v.number(),
    discount_amount: v.number(),
    delivery_fee_amount: v.number(),
    total_amount: v.number(),
    customer_notes: v.optional(v.string()),
    item_count: v.optional(v.number()),
    order_search_text: v.optional(v.string()),
    orderSummaryVersion: v.optional(v.number()),
    placed_at: v.number(),
    estimated_delivery_at: v.optional(v.number()),
    delivered_at: v.optional(v.number()),
    cancelled_at: v.optional(v.number()),
  })
    .index("by_number", ["order_number"])
    .index("by_customer", ["customer_id", "placed_at"])
    .index("by_store", ["store_id"])
    .index("by_status", ["status"])
    .index("by_placed", ["placed_at"])
    .index("by_store_placed", ["store_id", "placed_at"])
    .index("by_status_placed", ["status", "placed_at"])
    .index("by_store_status_placed", ["store_id", "status", "placed_at"])
    .index("by_order_stats_backfill", ["item_count", "placed_at"])
    .index("by_order_summary_version", ["orderSummaryVersion", "placed_at"])
    .searchIndex("search_orders", {
      searchField: "order_search_text",
      filterFields: ["status", "store_id"],
    }),

  order_items: defineTable({
    order_id: v.id("orders"),
    product_id: v.id("products"),
    sku_id: v.id("skus"),
    product_name_snapshot: v.string(),
    sku_label_snapshot: v.string(),
    quantity: v.number(),
    unit_price: v.number(),
    compare_at_price: v.optional(v.number()),
    line_total: v.number(),
  })
    .index("by_order", ["order_id"])
    .index("by_product", ["product_id"])
    .index("by_sku", ["sku_id"]),

  payment_methods: defineTable({
    customer_id: v.id("customers"),
    type: v.union(
      v.literal("cash_on_delivery"),
      v.literal("card"),
      v.literal("wallet"),
      v.literal("gcash"),
      v.literal("maya"),
    ),
    provider: v.optional(v.string()),
    label: v.string(),
    last4: v.optional(v.string()),
    token_ref: v.optional(v.string()),
    is_default: v.boolean(),
    created_at: v.number(),
  }).index("by_customer", ["customer_id"]),

  payments: defineTable({
    order_id: v.id("orders"),
    payment_method_id: v.optional(v.id("payment_methods")),
    provider: v.string(),
    provider_reference: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("authorized"),
      v.literal("paid"),
      v.literal("failed"),
      v.literal("refunded"),
    ),
    amount: v.number(),
    currency: v.string(),
    paid_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_order", ["order_id"]),

  reviews: defineTable({
    customer_id: v.id("customers"),
    product_id: v.id("products"),
    order_item_id: v.optional(v.id("order_items")),
    rating: v.number(),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_product", ["product_id"])
    .index("by_customer", ["customer_id"]),

  search_events: defineTable({
    customer_id: v.optional(v.id("customers")),
    anonymous_id: v.optional(v.string()),
    query: v.string(),
    result_count: v.number(),
    selected_product_id: v.optional(v.id("products")),
    created_at: v.number(),
  }).index("by_customer", ["customer_id", "created_at"]),

  support_tickets: defineTable({
    customer_id: v.id("customers"),
    order_id: v.optional(v.id("orders")),
    status: v.union(
      v.literal("open"),
      v.literal("waiting_for_customer"),
      v.literal("resolved"),
      v.literal("closed"),
    ),
    subject: v.string(),
    latest_message: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_customer", ["customer_id"])
    .index("by_status", ["status"]),

  notifications: defineTable({
    customer_id: v.id("customers"),
    title: v.string(),
    body: v.string(),
    deeplink: v.optional(v.string()),
    read_at: v.optional(v.number()),
    created_at: v.number(),
  }).index("by_customer_unread", ["customer_id", "read_at"]),
});
