import type {
  CategoryDoc,
  ProductDoc,
  PromotionDoc,
  StoreDoc,
} from "../../convex/model";

export type Product = ProductDoc;
export type Category = CategoryDoc;
export type Promotion = PromotionDoc;
export type Store = StoreDoc;

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

export type HomeSectionResponse = {
  id: string;
  key: string;
  kind: HomeSectionKind;
  title?: string;
  subtitle?: string;
  tab: string;
  sortOrder: number;
  layoutVariant?: string;
  backgroundColor?: string;
  textColor?: string;
  imageUrl?: string;
  iconEmoji?: string;
  maxItems?: number;
  config: Record<string, unknown>;
  resolvedData: {
    products?: Array<Product | Record<string, unknown>>;
    categories?: Array<Category | Record<string, unknown>>;
    promotions?: Array<Promotion | Record<string, unknown>>;
    stores?: Array<Store | Record<string, unknown>>;
    inventorySummary?: Record<string, unknown>;
  } & Record<string, unknown>;
};

export type HomeSectionsListResponse = {
  data: HomeSectionResponse[];
  total: number;
  limit: number;
  offset: number;
};
