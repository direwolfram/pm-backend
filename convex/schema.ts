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
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_phone", ["phone_country_code", "phone_number"])
    .index("by_status", ["status"])
    .index("by_referral_code", ["referral_code"]),

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
  })
    .index("by_parent", ["parent_id"])
    .index("by_slug", ["slug"]),

  products: defineTable({
    brand_id: v.optional(v.id("brands")),
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
    attributes: v.array(
      v.object({ key: v.string(), label: v.string(), value: v.string() }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_category", ["primary_category_id"])
    .index("by_brand", ["brand_id"])
    .index("by_slug", ["slug"])
    .index("by_status", ["status"])
    .searchIndex("search_products", {
      searchField: "name",
      filterFields: ["status", "primary_category_id", "brand_id"],
    }),

  product_media: defineTable({
    product_id: v.id("products"),
    url: v.string(),
    alt_text: v.optional(v.string()),
    dominant_color: v.optional(v.string()),
    sort_order: v.number(),
  }).index("by_product", ["product_id"]),

  product_similar_products: defineTable({
    product_id: v.id("products"),
    similar_product_id: v.id("products"),
  })
    .index("by_product", ["product_id"])
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
  })
    .index("by_product", ["product_id"])
    .index("by_sku_code", ["sku_code"])
    .index("by_barcode", ["barcode"]),

  prices: defineTable({
    sku_id: v.id("skus"),
    store_id: v.optional(v.id("stores")),
    currency: v.string(),
    sale_price: v.number(),
    compare_at_price: v.optional(v.number()),
    starts_at: v.number(),
    ends_at: v.optional(v.number()),
  })
    .index("by_sku", ["sku_id"])
    .index("by_sku_store", ["sku_id", "store_id"])
    .index("by_store", ["store_id"]),

  inventory: defineTable({
    sku_id: v.id("skus"),
    store_id: v.id("stores"),
    quantity_available: v.number(),
    quantity_reserved: v.number(),
    low_stock_threshold: v.number(),
    status: v.union(
      v.literal("in_stock"),
      v.literal("low_stock"),
      v.literal("out_of_stock"),
      v.literal("unavailable"),
    ),
    restock_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_sku_store", ["sku_id", "store_id"])
    .index("by_store_status", ["store_id", "status"])
    .index("by_sku", ["sku_id"]),

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
    .index("by_product", ["product_id"]),

  home_sections: defineTable({
    title: v.string(),
    kind: v.union(
      v.literal("product_carousel"),
      v.literal("category_grid"),
      v.literal("bestseller_grid"),
      v.literal("promo_banner"),
      v.literal("shopping_list_card"),
    ),
    tab: v.string(),
    sort_order: v.number(),
    is_active: v.boolean(),
  }).index("by_tab", ["tab", "sort_order"]),

  home_section_items: defineTable({
    section_id: v.id("home_sections"),
    product_id: v.optional(v.id("products")),
    category_id: v.optional(v.id("categories")),
    promotion_id: v.optional(v.id("promotions")),
    sort_order: v.number(),
  }).index("by_section", ["section_id"]),

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
    placed_at: v.number(),
    estimated_delivery_at: v.optional(v.number()),
    delivered_at: v.optional(v.number()),
    cancelled_at: v.optional(v.number()),
  })
    .index("by_number", ["order_number"])
    .index("by_customer", ["customer_id", "placed_at"])
    .index("by_store", ["store_id"])
    .index("by_status", ["status"]),

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
  }).index("by_order", ["order_id"]),

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
