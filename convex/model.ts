/**
 * Shared TypeScript types for PocketMart docs, used by both the Convex
 * functions and the admin frontend (import type-only from the frontend).
 * Ids are plain strings here so the frontend doesn't depend on codegen.
 */

export type Id<Table extends string = string> = string & { __table?: Table };

export interface BaseDoc {
  _id: string;
  _creationTime: number;
}

export type DeliveryMode = "express" | "savers" | "sari-sari";
export type CustomerStatus = "guest" | "active" | "blocked" | "deleted";
export type ProductStatus = "draft" | "active" | "hidden" | "discontinued";
export type InventoryStatus =
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "unavailable";
export type OrderStatus =
  | "pending_payment"
  | "confirmed"
  | "picking"
  | "packed"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "refunded";
export type PaymentStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "failed"
  | "refunded";
export type PromotionKind = "banner" | "carousel" | "coupon" | "product_discount";
export type DiscountType = "percent" | "fixed" | "free_delivery";
export type HomeSectionKind =
  | "header"
  | "search_bar"
  | "category_tabs"
  | "hero_banner"
  | "bestseller_grid"
  | "promo_banner"
  | "promo_carousel"
  | "shopping_list_card"
  | "category_grid"
  | "themed_product_section"
  | "product_carousel"
  | "featured_products"
  | "store_inventory_section"
  | "custom_cta"
  | "spacer";
export type SupportTicketStatus =
  | "open"
  | "waiting_for_customer"
  | "resolved"
  | "closed";
export type PaymentMethodType =
  | "cash_on_delivery"
  | "card"
  | "wallet"
  | "gcash"
  | "maya";

export interface CustomerDoc extends BaseDoc {
  phone_country_code: string;
  phone_number: string;
  display_name?: string;
  email?: string;
  avatar_url?: string;
  status: CustomerStatus;
  referral_code?: string;
  marketing_opt_in: boolean;
  created_at: number;
  updated_at: number;
}

export interface AddressDoc extends BaseDoc {
  customer_id: string;
  label: "home" | "work" | "school" | "other";
  title: string;
  full_address: string;
  street?: string;
  barangay?: string;
  city?: string;
  province?: string;
  postal_code?: string;
  country_code: string;
  latitude: number;
  longitude: number;
  delivery_notes?: string;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

export interface StoreDoc extends BaseDoc {
  name: string;
  status: "active" | "inactive";
  address: string;
  latitude: number;
  longitude: number;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface DeliveryZoneDoc extends BaseDoc {
  store_id: string;
  name: string;
  delivery_mode: DeliveryMode;
  min_order_amount: number;
  delivery_fee_amount: number;
  currency: string;
  estimated_minutes_min: number;
  estimated_minutes_max: number;
  is_active: boolean;
}

export interface BrandDoc extends BaseDoc {
  name: string;
  logo_url?: string;
  logo_color?: string;
  is_active: boolean;
}

export interface CategoryDoc extends BaseDoc {
  parent_id?: string;
  name: string;
  slug: string;
  section_name?: string;
  image_url?: string;
  icon_emoji?: string;
  background_color?: string;
  image_color?: string;
  sort_order: number;
  is_active: boolean;
}

export interface ProductAttribute {
  key: string;
  label: string;
  value: string;
}

export interface ProductDoc extends BaseDoc {
  sku?: string;
  brand_id?: string;
  categoryId?: string;
  primary_category_id: string;
  name: string;
  slug: string;
  description?: string;
  status: ProductStatus;
  tag?: string;
  pack_type?: string;
  brand?: string;
  basePrice?: number;
  weightKg?: number;
  volumeL?: number;
  isFragile?: boolean;
  isFlammable?: boolean;
  temperatureZone?: "ambient" | "chilled" | "frozen";
  packagingType?: string;
  isFreshProduce?: boolean;
  isReturnable?: boolean;
  searchKeywords?: string[];
  images?: string[];
  substituteSkuIds?: string[];
  substitutePriority?: number;
  allowSubstitution?: boolean;
  isExpressAvailable?: boolean;
  isFrequentlyBought?: boolean;
  shelf_life?: string;
  flavour?: string;
  finish?: string;
  paraben_free?: boolean;
  colour_family?: string;
  badge_text?: string;
  icon_emoji?: string;
  image_color?: string;
  rating_average: number;
  rating_count: number;
  attributes: ProductAttribute[];
  created_at: number;
  updated_at: number;
}

export interface ProductMediaDoc extends BaseDoc {
  product_id: string;
  url: string;
  storage_id?: string;
  alt_text?: string;
  dominant_color?: string;
  is_showcase?: boolean;
  sort_order: number;
}

export interface SkuDoc extends BaseDoc {
  product_id: string;
  sku_code: string;
  barcode?: string;
  display_name?: string;
  variant_label: string;
  pack_size?: string;
  unit_of_measure?: string;
  shade_name?: string;
  shade_color?: string;
  image_color?: string;
  badge_text?: string;
  sort_order: number;
  is_default: boolean;
  is_active: boolean;
}

export interface PriceDoc extends BaseDoc {
  sku_id: string;
  store_id?: string;
  currency: string;
  sale_price: number;
  compare_at_price?: number;
  starts_at: number;
  ends_at?: number;
}

export interface InventoryDoc extends BaseDoc {
  sku_id: string;
  store_id: string;
  quantity_available: number;
  quantity_reserved: number;
  low_stock_threshold: number;
  status: InventoryStatus;
  restock_at?: number;
  updated_at: number;
}

export interface PromotionDoc extends BaseDoc {
  kind: PromotionKind;
  title: string;
  subtitle?: string;
  description?: string;
  image_url?: string;
  background_color?: string;
  discount_type?: DiscountType;
  discount_value?: number;
  coupon_code?: string;
  minimum_order_amount?: number;
  max_discount_amount?: number;
  currency: string;
  starts_at: number;
  ends_at: number;
  is_active: boolean;
}

export interface PromotionTargetDoc extends BaseDoc {
  promotion_id: string;
  product_id?: string;
  sku_id?: string;
  category_id?: string;
  brand_id?: string;
}

export interface HomeSectionDoc extends BaseDoc {
  id?: string;
  key?: string;
  kind: HomeSectionKind;
  title?: string;
  subtitle?: string;
  tab: string;
  sortOrder?: number;
  isActive?: boolean;
  allowEmpty?: boolean;
  startsAt?: number;
  endsAt?: number;
  timezone?: string;
  visibleDaysOfWeek?: number[];
  visibleTimeWindows?: { start: string; end: string }[];
  holidayTags?: string[];
  seasonalTags?: string[];
  storeIds?: string[];
  cityIds?: string[];
  regionIds?: string[];
  customerSegments?: string[];
  appVersion?: string;
  minAppVersion?: string;
  maxAppVersion?: string;
  layoutVariant?: string;
  backgroundColor?: string;
  textColor?: string;
  imageUrl?: string;
  iconEmoji?: string;
  maxItems?: number;
  productIds?: string[];
  categoryIds?: string[];
  promotionIds?: string[];
  brandIds?: string[];
  config?: Record<string, unknown>;
  resolvedData?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  sort_order?: number;
  is_active?: boolean;
}

export interface HomeSectionResponse {
  id: string;
  key: string;
  kind: HomeSectionKind;
  title?: string;
  subtitle?: string;
  tab: string;
  sortOrder: number;
  layoutVariant?: string;
  config: Record<string, unknown>;
  resolvedData: Record<string, unknown> & {
    products?: Array<ProductDoc | Record<string, unknown>>;
    categories?: Array<CategoryDoc | Record<string, unknown>>;
    promotions?: Array<PromotionDoc | Record<string, unknown>>;
    stores?: Array<StoreDoc | Record<string, unknown>>;
    inventorySummary?: Record<string, unknown>;
  };
}

export interface HomeSectionItemDoc extends BaseDoc {
  section_id: string;
  product_id?: string;
  category_id?: string;
  promotion_id?: string;
  sort_order: number;
}

export interface OrderDoc extends BaseDoc {
  order_number: string;
  customer_id: string;
  cart_id?: string;
  store_id: string;
  address_id: string;
  delivery_mode: DeliveryMode;
  status: OrderStatus;
  payment_status: PaymentStatus;
  currency: string;
  subtotal_amount: number;
  discount_amount: number;
  delivery_fee_amount: number;
  total_amount: number;
  customer_notes?: string;
  placed_at: number;
  estimated_delivery_at?: number;
  delivered_at?: number;
  cancelled_at?: number;
}

export interface OrderItemDoc extends BaseDoc {
  order_id: string;
  product_id: string;
  sku_id: string;
  product_name_snapshot: string;
  sku_label_snapshot: string;
  quantity: number;
  unit_price: number;
  compare_at_price?: number;
  line_total: number;
}

export interface PaymentDoc extends BaseDoc {
  order_id: string;
  payment_method_id?: string;
  provider: string;
  provider_reference?: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paid_at?: number;
  created_at: number;
  updated_at: number;
}

export interface ReviewDoc extends BaseDoc {
  customer_id: string;
  product_id: string;
  order_item_id?: string;
  rating: number;
  title?: string;
  body?: string;
  created_at: number;
}

export interface SupportTicketDoc extends BaseDoc {
  customer_id: string;
  order_id?: string;
  status: SupportTicketStatus;
  subject: string;
  latest_message: string;
  created_at: number;
  updated_at: number;
}

export interface NotificationDoc extends BaseDoc {
  customer_id: string;
  title: string;
  body: string;
  deeplink?: string;
  read_at?: number;
  created_at: number;
}

/** Enriched rows returned by admin list queries. */
export interface ProductListRow extends ProductDoc {
  brand_name?: string;
  category_name?: string;
  sku_count: number;
  default_sku_id?: string;
  default_price?: number;
  total_stock: number;
}

export interface InventoryRow extends InventoryDoc {
  sku_code: string;
  variant_label: string;
  product_name: string;
  product_id: string;
}

export interface OrderListRow extends OrderDoc {
  customer_name?: string;
  store_name?: string;
  item_count: number;
}

export interface DashboardStats {
  total_products: number;
  active_products: number;
  total_skus: number;
  total_orders: number;
  orders_today: number;
  revenue_total: number;
  revenue_today: number;
  low_stock_count: number;
  out_of_stock_count: number;
  total_customers: number;
  open_tickets: number;
  active_promotions: number;
}
