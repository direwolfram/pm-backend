import { mutation } from "./functions";
import { deriveInventoryStatus, now, orderNumber, slugify } from "./helpers";
import {
  CUSTOMER_ORDER_STATS_VERSION,
  customerSearchText,
  orderCountsForCustomerStats,
} from "./lib/customerAggregates";
import { PRODUCT_LIST_SUMMARY_VERSION } from "./lib/productListSummaries";
import { ORDER_SUMMARY_VERSION, orderSearchText } from "./orders";
import {
  customerCountKeys,
  orderCountKeys,
  productCountKeys,
} from "./listCounts";
import type { CustomerDoc, OrderDoc } from "./model";

/**
 * Seeds a sample Philippine grocery catalog: stores, zones, brands,
 * categories, ~20 products with SKUs/prices/inventory, promotions,
 * home sections, customers, orders. Idempotent — skips if products exist.
 * Run from the dashboard or with: npx convex run seed:run
 */
export const run = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("products").first();
    if (existing) {
      return { seeded: false, message: "Database already has products — skipping seed." };
    }
    const t = now();
    const day = 24 * 60 * 60 * 1000;

    // ---- Stores + zones ----
    const storeMakati = await ctx.db.insert("stores", {
      name: "PocketMart Makati Central",
      status: "active",
      address: "123 Kalayaan Ave, Poblacion, Makati, Metro Manila",
      latitude: 14.5653,
      longitude: 121.0306,
      timezone: "Asia/Manila",
      created_at: t,
      updated_at: t,
    });
    const storeQC = await ctx.db.insert("stores", {
      name: "PocketMart Quezon City",
      status: "active",
      address: "45 Commonwealth Ave, Batasan Hills, Quezon City",
      latitude: 14.676,
      longitude: 121.0437,
      timezone: "Asia/Manila",
      created_at: t,
      updated_at: t,
    });
    for (const storeId of [storeMakati, storeQC]) {
      await ctx.db.insert("delivery_zones", {
        store_id: storeId,
        name: "Express — within 3 km",
        delivery_mode: "express",
        min_order_amount: 0,
        delivery_fee_amount: 29,
        currency: "PHP",
        estimated_minutes_min: 15,
        estimated_minutes_max: 30,
        is_active: true,
      });
      await ctx.db.insert("delivery_zones", {
        store_id: storeId,
        name: "Savers — within 6 km",
        delivery_mode: "savers",
        min_order_amount: 199,
        delivery_fee_amount: 0,
        currency: "PHP",
        estimated_minutes_min: 45,
        estimated_minutes_max: 90,
        is_active: true,
      });
      await ctx.db.insert("delivery_zones", {
        store_id: storeId,
        name: "Sari-sari pickup",
        delivery_mode: "sari-sari",
        min_order_amount: 0,
        delivery_fee_amount: 0,
        currency: "PHP",
        estimated_minutes_min: 120,
        estimated_minutes_max: 240,
        is_active: true,
      });
    }

    // ---- Brands ----
    const brandIds: Record<string, string> = {};
    for (const [name, color] of [
      ["Coca-Cola", "#B71C1C"],
      ["Nestlé", "#0D47A1"],
      ["Lucky Me", "#E65100"],
      ["Argentina", "#4E342E"],
      ["Colgate", "#B71C1C"],
      ["Del Monte", "#1B5E20"],
    ] as const) {
      brandIds[name] = (await ctx.db.insert("brands", {
        name,
        logo_color: color,
        is_active: true,
      })) as string;
    }

    // ---- Categories ----
    const cat = async (
      name: string,
      emoji: string,
      color: string,
      sort: number,
      parent?: string,
      section?: string,
    ) =>
      (await ctx.db.insert("categories", {
        parent_id: parent,
        name,
        slug: slugify(name),
        section_name: section,
        icon_emoji: emoji,
        background_color: color,
        image_color: color,
        sort_order: sort,
        is_active: true,
      })) as string;

    const beverages = await cat("Beverages", "🥤", "#E3F2FD", 1, undefined, "Food & Drinks");
    const softdrinks = await cat("Soft Drinks", "🥤", "#FFEBEE", 1, beverages);
    const coffeeTea = await cat("Coffee & Tea", "☕", "#EFEBE9", 2, beverages);
    const juices = await cat("Juices", "🧃", "#FFF8E1", 3, beverages);
    const pantry = await cat("Pantry", "🥫", "#FFF3E0", 2, undefined, "Food & Drinks");
    const noodles = await cat("Instant Noodles", "🍜", "#FFF3E0", 1, pantry);
    const canned = await cat("Canned Goods", "🥫", "#EFEBE9", 2, pantry);
    const snacks = await cat("Snacks", "🍪", "#F3E5F5", 3, undefined, "Food & Drinks");
    const personalCare = await cat("Personal Care", "🧴", "#E0F7FA", 4, undefined, "Essentials");
    const household = await cat("Household", "🧹", "#E8F5E9", 5, undefined, "Essentials");

    // ---- Products + SKUs + prices + inventory ----
    interface SeedProduct {
      name: string;
      brand?: string;
      category: string;
      emoji: string;
      color: string;
      tag?: string;
      flavour?: string;
      images?: string[];
      rating: number;
      ratingCount: number;
      skus: {
        label: string;
        code: string;
        price: number;
        compareAt?: number;
        stockMakati: number;
        stockQC: number;
        isDefault?: boolean;
      }[];
    }
    const dummyProductImages = [
      "F7C948",
      "90CDF4",
      "C6F6D5",
      "FBB6CE",
    ];
    const dummyImagesForProduct = (name: string) =>
      dummyProductImages.map((color, imageIndex) => {
        const label = imageIndex === 0 ? `${name} Showcase` : `${name} Slide ${imageIndex + 1}`;
        return `https://placehold.co/800x800/${color}/111827?text=${encodeURIComponent(label)}`;
      });
    const P = (p: SeedProduct) => p;
    const products: SeedProduct[] = [
      P({
        name: "Coca-Cola Soft Drink", brand: "Coca-Cola", category: softdrinks,
        emoji: "🥤", color: "#B71C1C", tag: "Chilled", flavour: "Cola",
        rating: 4.4, ratingCount: 12500,
        skus: [
          { label: "1.5 ltr", code: "COKE-1.5L", price: 65, compareAt: 72, stockMakati: 42, stockQC: 30, isDefault: true },
          { label: "2 ltr", code: "COKE-2L", price: 85, compareAt: 95, stockMakati: 18, stockQC: 12 },
          { label: "330 ml can", code: "COKE-330", price: 32, stockMakati: 96, stockQC: 88 },
        ],
      }),
      P({
        name: "Sprite Lemon-Lime Soda", brand: "Coca-Cola", category: softdrinks,
        emoji: "🥤", color: "#2E7D32", tag: "Chilled", flavour: "Lemon-Lime",
        rating: 4.3, ratingCount: 8300,
        skus: [{ label: "1.5 ltr", code: "SPRITE-1.5L", price: 62, stockMakati: 25, stockQC: 20, isDefault: true }],
      }),
      P({
        name: "Royal Tru-Orange", brand: "Coca-Cola", category: softdrinks,
        emoji: "🍊", color: "#EF6C00", flavour: "Orange",
        rating: 4.2, ratingCount: 5100,
        skus: [{ label: "1.5 ltr", code: "ROYAL-1.5L", price: 58, stockMakati: 0, stockQC: 14, isDefault: true }],
      }),
      P({
        name: "Nescafé Classic 3-in-1 Coffee", brand: "Nestlé", category: coffeeTea,
        emoji: "☕", color: "#4E342E", tag: "Bestseller",
        rating: 4.6, ratingCount: 21000,
        skus: [
          { label: "10 × 20 g pack", code: "NESCAFE-3IN1-10", price: 75, compareAt: 85, stockMakati: 60, stockQC: 45, isDefault: true },
          { label: "30 × 20 g pack", code: "NESCAFE-3IN1-30", price: 199, compareAt: 230, stockMakati: 22, stockQC: 15 },
        ],
      }),
      P({
        name: "Milo Chocolate Malt Drink", brand: "Nestlé", category: beverages,
        emoji: "🍫", color: "#33691E",
        rating: 4.7, ratingCount: 18400,
        skus: [{ label: "300 g", code: "MILO-300G", price: 145, stockMakati: 35, stockQC: 28, isDefault: true }],
      }),
      P({
        name: "Del Monte Pineapple Juice", brand: "Del Monte", category: juices,
        emoji: "🍍", color: "#F9A825", flavour: "Pineapple",
        rating: 4.3, ratingCount: 3200,
        skus: [{ label: "1 ltr tetra", code: "DM-PINE-1L", price: 98, compareAt: 110, stockMakati: 16, stockQC: 9, isDefault: true }],
      }),
      P({
        name: "Lucky Me Pancit Canton Original", brand: "Lucky Me", category: noodles,
        emoji: "🍜", color: "#E65100", tag: "Bestseller", flavour: "Original",
        rating: 4.5, ratingCount: 45000,
        skus: [
          { label: "60 g pack", code: "LM-PC-ORIG-60", price: 16, stockMakati: 200, stockQC: 180, isDefault: true },
          { label: "6 × 60 g multipack", code: "LM-PC-ORIG-6PK", price: 89, compareAt: 96, stockMakati: 40, stockQC: 33 },
        ],
      }),
      P({
        name: "Lucky Me Pancit Canton Calamansi", brand: "Lucky Me", category: noodles,
        emoji: "🍜", color: "#7CB342", flavour: "Calamansi",
        rating: 4.4, ratingCount: 31000,
        skus: [{ label: "60 g pack", code: "LM-PC-CAL-60", price: 16, stockMakati: 150, stockQC: 140, isDefault: true }],
      }),
      P({
        name: "Argentina Corned Beef", brand: "Argentina", category: canned,
        emoji: "🥫", color: "#5D4037",
        rating: 4.4, ratingCount: 12800,
        skus: [
          { label: "175 g", code: "ARG-CB-175", price: 52, stockMakati: 48, stockQC: 40, isDefault: true },
          { label: "260 g", code: "ARG-CB-260", price: 78, compareAt: 85, stockMakati: 4, stockQC: 20 },
        ],
      }),
      P({
        name: "555 Sardines in Tomato Sauce", category: canned,
        emoji: "🐟", color: "#C62828",
        rating: 4.1, ratingCount: 9600,
        skus: [{ label: "155 g", code: "555-SARD-155", price: 24, stockMakati: 80, stockQC: 65, isDefault: true }],
      }),
      P({
        name: "Del Monte Spaghetti Sauce Filipino Style", brand: "Del Monte", category: pantry,
        emoji: "🍝", color: "#B71C1C",
        rating: 4.5, ratingCount: 7400,
        skus: [{ label: "500 g pouch", code: "DM-SPAG-500", price: 62, stockMakati: 30, stockQC: 25, isDefault: true }],
      }),
      P({
        name: "Lady's Choice Real Mayonnaise", category: pantry,
        emoji: "🥪", color: "#1565C0",
        rating: 4.6, ratingCount: 8900,
        skus: [{ label: "470 ml", code: "LC-MAYO-470", price: 155, compareAt: 169, stockMakati: 12, stockQC: 8, isDefault: true }],
      }),
      P({
        name: "Oreo Chocolate Sandwich Cookies", category: snacks,
        emoji: "🍪", color: "#1A237E", tag: "Chilled",
        rating: 4.5, ratingCount: 15200,
        skus: [
          { label: "9 × 28.5 g pack", code: "OREO-9PK", price: 68, stockMakati: 55, stockQC: 47, isDefault: true },
          { label: "133 g single pack", code: "OREO-133", price: 42, stockMakati: 70, stockQC: 61 },
        ],
      }),
      P({
        name: "Piattos Cheese Chips", category: snacks,
        emoji: "🧀", color: "#F57F17", flavour: "Cheese",
        rating: 4.3, ratingCount: 11500,
        skus: [{ label: "85 g", code: "PIATTOS-CHZ-85", price: 38, stockMakati: 3, stockQC: 22, isDefault: true }],
      }),
      P({
        name: "SkyFlakes Crackers", category: snacks,
        emoji: "🍘", color: "#FDD835",
        rating: 4.4, ratingCount: 19800,
        skus: [{ label: "10 × 25 g pack", code: "SKYFLAKES-10PK", price: 52, stockMakati: 65, stockQC: 58, isDefault: true }],
      }),
      P({
        name: "Colgate Triple Action Toothpaste", brand: "Colgate", category: personalCare,
        emoji: "🪥", color: "#B71C1C",
        rating: 4.5, ratingCount: 6700,
        skus: [{ label: "145 ml", code: "COLGATE-TA-145", price: 98, compareAt: 112, stockMakati: 26, stockQC: 19, isDefault: true }],
      }),
      P({
        name: "Safeguard Pure White Soap", category: personalCare,
        emoji: "🧼", color: "#FFFFFF",
        rating: 4.6, ratingCount: 14300,
        skus: [{ label: "3 × 85 g pack", code: "SAFEGUARD-3PK", price: 95, stockMakati: 38, stockQC: 31, isDefault: true }],
      }),
      P({
        name: "Head & Shoulders Shampoo", category: personalCare,
        emoji: "🧴", color: "#0277BD",
        rating: 4.4, ratingCount: 5900,
        skus: [{ label: "170 ml", code: "HNS-170", price: 135, stockMakati: 0, stockQC: 6, isDefault: true }],
      }),
      P({
        name: "Joy Dishwashing Liquid Kalamansi", category: household,
        emoji: "🍋", color: "#558B2F",
        rating: 4.5, ratingCount: 9100,
        skus: [{ label: "495 ml", code: "JOY-KAL-495", price: 89, compareAt: 99, stockMakati: 33, stockQC: 27, isDefault: true }],
      }),
      P({
        name: "Ariel Powder Detergent Sunrise Fresh", category: household,
        emoji: "👕", color: "#00838F",
        rating: 4.6, ratingCount: 10200,
        skus: [{ label: "900 g", code: "ARIEL-900", price: 165, compareAt: 185, stockMakati: 15, stockQC: 11, isDefault: true }],
      }),
    ];

    const productIds: Record<string, string> = {};
    const firstSkuByProduct: Record<string, string> = {};
    for (const p of products) {
      const images = p.images ?? dummyImagesForProduct(p.name);
      const pid = (await ctx.db.insert("products", {
        brand_id: p.brand ? brandIds[p.brand] : undefined,
        primary_category_id: p.category,
        name: p.name,
        slug: slugify(p.name),
        status: "active",
        tag: p.tag,
        flavour: p.flavour,
        icon_emoji: p.emoji,
        image_color: p.color,
        images,
        rating_average: p.rating,
        rating_count: p.ratingCount,
        attributes: [],
        created_at: t,
        updated_at: t,
      })) as string;
      productIds[p.name] = pid;
      for (const [mediaIndex, image] of images.entries()) {
        await ctx.db.insert("product_media", {
          product_id: pid,
          url: image,
          alt_text: `${p.name} image ${mediaIndex + 1}`,
          is_showcase: mediaIndex === 0,
          sort_order: mediaIndex,
        });
      }
      let totalStock = 0;
      let defaultSkuId: string | undefined;
      let defaultPrice: number | undefined;
      for (const [i, s] of p.skus.entries()) {
        const skuId = (await ctx.db.insert("skus", {
          product_id: pid,
          sku_code: s.code,
          variant_label: s.label,
          sort_order: i,
          is_default: s.isDefault ?? false,
          is_active: true,
        })) as string;
        if (i === 0) firstSkuByProduct[pid] = skuId;
        const priceId = await ctx.db.insert("prices", {
          sku_id: skuId,
          product_id: pid,
          currency: "PHP",
          sale_price: s.price,
          compare_at_price: s.compareAt,
          starts_at: t - day,
          priceSummaryVersion: 2,
        });
        await ctx.db.insert("pricesActive", {
          sku_id: skuId,
          price_id: priceId,
          product_id: pid,
          sale_price: s.price,
          starts_at: t - day,
        });
        if (s.isDefault) {
          defaultSkuId = skuId;
          defaultPrice = s.price;
        }
        for (const [storeId, qty] of [
          [storeMakati, s.stockMakati],
          [storeQC, s.stockQC],
        ] as const) {
          totalStock += qty;
          await ctx.db.insert("inventory", {
            sku_id: skuId,
            store_id: storeId,
            quantity_available: qty,
            quantity_reserved: 0,
            low_stock_threshold: 5,
            status: deriveInventoryStatus({
              quantityAvailable: qty,
              lowStockThreshold: 5,
            }),
            productId: pid,
            skuCode: s.code,
            variantLabel: s.label,
            productName: p.name,
            storeName: storeId === storeMakati ? "PocketMart Makati Central" : "PocketMart Quezon City",
            updated_at: t,
            storeInventorySummaryVersion: 1,
          });
        }
      }
      // Maintain the product list summary inline so seeded rows never need
      // a backfill pass.
      await ctx.db.patch(pid as any, {
        sku_count: p.skus.length,
        default_sku_id: defaultSkuId,
        default_price: defaultPrice,
        total_stock: totalStock,
        productListSummaryVersion: PRODUCT_LIST_SUMMARY_VERSION,
      });
    }

    // similar products: pair the soft drinks, pair the noodles
    const similarPairs: [string, string][] = [
      ["Coca-Cola Soft Drink", "Sprite Lemon-Lime Soda"],
      ["Coca-Cola Soft Drink", "Royal Tru-Orange"],
      ["Lucky Me Pancit Canton Original", "Lucky Me Pancit Canton Calamansi"],
      ["Nescafé Classic 3-in-1 Coffee", "Milo Chocolate Malt Drink"],
    ];
    for (const [a, b] of similarPairs) {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        await ctx.db.insert("product_similar_products", {
          product_id: productIds[x],
          similar_product_id: productIds[y],
        });
      }
    }

    // ---- Promotions ----
    const promoBanner = (await ctx.db.insert("promotions", {
      kind: "banner",
      title: "Payday Sale — up to 15% off",
      subtitle: "On beverages and pantry staples",
      background_color: "#B71C1C",
      discount_type: "percent",
      discount_value: 15,
      currency: "PHP",
      starts_at: t - day,
      ends_at: t + 6 * day,
      is_active: true,
    })) as string;
    await ctx.db.insert("promotion_targets", {
      promotion_id: promoBanner,
      category_id: beverages,
    });
    const promoCoupon = (await ctx.db.insert("promotions", {
      kind: "coupon",
      title: "₱50 off your first order",
      coupon_code: "POCKET50",
      discount_type: "fixed",
      discount_value: 50,
      minimum_order_amount: 299,
      currency: "PHP",
      starts_at: t - day,
      ends_at: t + 30 * day,
      is_active: true,
    })) as string;
    const promoFreeDelivery = (await ctx.db.insert("promotions", {
      kind: "coupon",
      title: "Free delivery this weekend",
      coupon_code: "FREEDEL",
      discount_type: "free_delivery",
      minimum_order_amount: 199,
      currency: "PHP",
      starts_at: t - day,
      ends_at: t + 2 * day,
      is_active: true,
    })) as string;
    const promoCoke = (await ctx.db.insert("promotions", {
      kind: "product_discount",
      title: "Coke 1.5L — save ₱7",
      discount_type: "fixed",
      discount_value: 7,
      currency: "PHP",
      starts_at: t - day,
      ends_at: t + 13 * day,
      is_active: true,
    })) as string;
    await ctx.db.insert("promotion_targets", {
      promotion_id: promoCoke,
      product_id: productIds["Coca-Cola Soft Drink"],
    });

    // ---- Home sections ----
    const insertSection = async (section: Record<string, unknown>) => {
      const id = await ctx.db.insert("home_sections", {
        allowEmpty: false,
        timezone: "Asia/Manila",
        createdAt: t,
        updatedAt: t,
        ...section,
        isActive: true,
      });
      await ctx.db.patch(id, { id });
      return id;
    };
    const promoIds = [promoBanner, promoCoupon, promoFreeDelivery, promoCoke];
    await insertSection({
      key: "header_default",
      kind: "header",
      title: "Header",
      tab: "All",
      sortOrder: 0,
      backgroundColor: "#FFFFFF",
      config: {
        showLocation: true,
        showProfile: true,
        showCart: true,
        backgroundColor: "#FFFFFF",
        variant: "default",
      },
    });
    await insertSection({
      key: "search_bar_default",
      kind: "search_bar",
      title: "Search",
      tab: "All",
      sortOrder: 10,
      config: {
        placeholder: "Search for groceries",
        showMic: true,
        showScanner: true,
        stickyOnScroll: true,
        variant: "rounded",
      },
    });
    await insertSection({
      key: "category_tabs_default",
      kind: "category_tabs",
      title: "Tabs",
      tab: "All",
      sortOrder: 20,
      categoryIds: [beverages, pantry, snacks, personalCare, household],
      config: {
        tabs: ["All", "Grocery", "Snacks", "Beauty"],
        defaultTab: "All",
        stickyOnScroll: true,
        variant: "pill",
      },
    });
    await insertSection({
      key: "hero_default",
      kind: "hero_banner",
      title: "Fresh groceries in minutes",
      subtitle: "Daily essentials delivered fast.",
      tab: "All",
      sortOrder: 30,
      layoutVariant: "wide",
      imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e",
      config: {
        title: "Fresh groceries in minutes",
        subtitle: "Daily essentials delivered fast.",
        imageUrl: "https://images.unsplash.com/photo-1542838132-92c53300491e",
        ctaLabel: "Shop now",
        ctaRoute: "/categories",
        variant: "wide",
      },
    });
    await insertSection({
      key: "bestsellers_default",
      kind: "bestseller_grid",
      title: "Bestsellers",
      tab: "All",
      sortOrder: 40,
      maxItems: 8,
      productIds: [
        productIds["Lucky Me Pancit Canton Original"],
        productIds["Nescafé Classic 3-in-1 Coffee"],
        productIds["Coca-Cola Soft Drink"],
        productIds["Milo Chocolate Malt Drink"],
      ],
      config: { columns: 2, showMoreCount: 4, maxItems: 8 },
    });
    await insertSection({
      key: "promo_banner_match_time",
      kind: "promo_banner",
      title: "Match time deals",
      tab: "All",
      sortOrder: 50,
      promotionIds: [promoBanner],
      backgroundColor: "#B71C1C",
      visibleTimeWindows: [{ start: "17:00", end: "23:59" }],
      config: {
        promotionIds: [promoBanner],
        title: "Match time deals",
        subtitle: "Snacks and drinks for tonight.",
        backgroundColor: "#B71C1C",
        ctaLabel: "Grab deals",
        ctaRoute: "/promotions",
      },
    });
    await insertSection({
      key: "promo_carousel_default",
      kind: "promo_carousel",
      title: "Promos",
      tab: "All",
      sortOrder: 60,
      promotionIds: promoIds,
      config: {
        promotionIds: promoIds,
        autoplay: true,
        autoplayIntervalMs: 4500,
        loop: true,
        cardVariant: "compact",
      },
    });
    await insertSection({
      key: "shopping_list_card_default",
      kind: "shopping_list_card",
      title: "Shopping list",
      tab: "All",
      sortOrder: 70,
      config: {
        title: "Build your basket faster",
        subtitle: "Paste a list and we will find matches.",
        ctaLabel: "Open list",
        ctaRoute: "/shopping-list",
        iconName: "list-plus",
      },
    });
    await insertSection({
      key: "grocery_category_grid",
      kind: "category_grid",
      title: "Grocery",
      tab: "Grocery",
      sortOrder: 80,
      categoryIds: [beverages, pantry, noodles, canned],
      maxItems: 8,
      config: { columns: 4, sectionTitle: "Grocery", showIcons: true, maxItems: 8 },
    });
    await insertSection({
      key: "snacks_category_grid",
      kind: "category_grid",
      title: "Snacks",
      tab: "Snacks",
      sortOrder: 90,
      categoryIds: [snacks],
      maxItems: 8,
      config: { columns: 4, sectionTitle: "Snacks", showIcons: true, maxItems: 8 },
    });
    await insertSection({
      key: "beauty_category_grid",
      kind: "category_grid",
      title: "Beauty",
      tab: "Beauty",
      sortOrder: 100,
      categoryIds: [personalCare],
      maxItems: 8,
      config: { columns: 4, sectionTitle: "Beauty", showIcons: true, maxItems: 8 },
    });
    await insertSection({
      key: "fresh_day_section",
      kind: "themed_product_section",
      title: "Fresh Day",
      tab: "All",
      sortOrder: 110,
      backgroundColor: "#E8F5E9",
      productIds: [
        productIds["Del Monte Pineapple Juice"],
        productIds["Milo Chocolate Malt Drink"],
        productIds["Lady's Choice Real Mayonnaise"],
      ],
      maxItems: 6,
      config: {
        productIds: [
          productIds["Del Monte Pineapple Juice"],
          productIds["Milo Chocolate Malt Drink"],
          productIds["Lady's Choice Real Mayonnaise"],
        ],
        themeName: "Fresh Day",
        themeEmoji: "🌿",
        backgroundColor: "#E8F5E9",
        titleColor: "#1B5E20",
        maxItems: 6,
      },
    });
    await insertSection({
      key: "sweet_tooth_products",
      kind: "product_carousel",
      title: "Sweet tooth",
      tab: "Snacks",
      sortOrder: 120,
      productIds: [
        productIds["Oreo Chocolate Sandwich Cookies"],
        productIds["Milo Chocolate Malt Drink"],
      ],
      maxItems: 8,
      config: {
        title: "Sweet tooth",
        showSeeAll: true,
        seeAllRoute: "/categories/snacks",
        maxItems: 8,
      },
    });
    await insertSection({
      key: "cold_drinks_products",
      kind: "product_carousel",
      title: "Cold drinks",
      tab: "Grocery",
      sortOrder: 130,
      categoryIds: [softdrinks, juices],
      maxItems: 8,
      config: {
        title: "Cold drinks",
        showSeeAll: true,
        seeAllRoute: "/categories/beverages",
        maxItems: 8,
      },
    });
    await insertSection({
      key: "featured_products",
      kind: "featured_products",
      title: "Featured products",
      tab: "All",
      sortOrder: 140,
      productIds: [
        productIds["Coca-Cola Soft Drink"],
        productIds["Lucky Me Pancit Canton Original"],
        productIds["Argentina Corned Beef"],
        productIds["Colgate Triple Action Toothpaste"],
      ],
      maxItems: 8,
      config: {
        title: "Featured products",
        subtitle: "Picked for this week",
        maxItems: 8,
        showSeeAll: true,
      },
    });
    await insertSection({
      key: "dry_fruit_products",
      kind: "product_carousel",
      title: "Pantry favorites",
      tab: "Grocery",
      sortOrder: 150,
      categoryIds: [pantry, canned],
      maxItems: 8,
      config: { title: "Pantry favorites", maxItems: 8, showSeeAll: true },
    });
    await insertSection({
      key: "instant_food_products",
      kind: "product_carousel",
      title: "Instant food",
      tab: "Grocery",
      sortOrder: 160,
      categoryIds: [noodles],
      maxItems: 8,
      config: {
        categoryId: noodles,
        title: "Instant food",
        maxItems: 8,
        showSeeAll: true,
      },
    });
    await insertSection({
      key: "beauty_products",
      kind: "product_carousel",
      title: "Beauty essentials",
      tab: "Beauty",
      sortOrder: 170,
      categoryIds: [personalCare],
      brandIds: [brandIds.Colgate],
      maxItems: 8,
      config: {
        categoryId: personalCare,
        title: "Beauty essentials",
        maxItems: 8,
        showSeeAll: true,
      },
    });
    await insertSection({
      key: "store_inventory_summary",
      kind: "store_inventory_section",
      title: "Store stock",
      tab: "All",
      sortOrder: 180,
      storeIds: [storeMakati, storeQC],
      allowEmpty: true,
      config: {
        storeIds: [storeMakati, storeQC],
        showInventorySummary: true,
        showAvailability: true,
        statusFilter: "available",
        maxItems: 8,
      },
    });
    // ---- Customers + addresses + settings ----
    const customerSeed = [
      { name: "Maria Santos", phone: "9171234567", code: "MARIA8K2" },
      { name: "Juan Dela Cruz", phone: "9187654321", code: "JUAN4F9" },
      { name: "Ana Reyes", phone: "9195551234", code: "ANA2X7Q" },
    ];
    const customerIds: string[] = [];
    const addressIds: string[] = [];
    for (const [i, c] of customerSeed.entries()) {
      const cid = (await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: c.phone,
        display_name: c.name,
        status: "active",
        referral_code: c.code,
        marketing_opt_in: i !== 2,
        search_text: customerSearchText({
          display_name: c.name,
          phone_country_code: "+63",
          phone_number: c.phone,
        }),
        order_count: 0,
        total_spend: 0,
        customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
        created_at: t - (30 - i * 5) * day,
        updated_at: t,
      })) as string;
      customerIds.push(cid);
      addressIds.push(
        (await ctx.db.insert("addresses", {
          customer_id: cid,
          label: "home",
          title: "Home",
          full_address: `Unit ${100 + i}, Sample Residences, Makati, Metro Manila`,
          barangay: "Poblacion",
          city: "Makati",
          province: "Metro Manila",
          postal_code: "1210",
          country_code: "PH",
          latitude: 14.5653 + i * 0.002,
          longitude: 121.0306 + i * 0.002,
          is_default: true,
          created_at: t,
          updated_at: t,
        })) as string,
      );
      await ctx.db.insert("customer_settings", {
        customer_id: cid,
        theme: "system",
        preferred_delivery_mode: "express",
        push_notifications_enabled: true,
        sms_notifications_enabled: true,
        whatsapp_notifications_enabled: i === 0,
        updated_at: t,
      });
    }

    // ---- Orders (with snapshots) + payments ----
    const orderSeed: {
      customer: number;
      address: number;
      store: string;
      status:
        | "delivered"
        | "out_for_delivery"
        | "picking"
        | "confirmed"
        | "pending_payment";
      payment: "paid" | "pending";
      placedDaysAgo: number;
      items: { product: string; qty: number }[];
    }[] = [
      {
        customer: 0, address: 0, store: storeMakati, status: "delivered", payment: "paid",
        placedDaysAgo: 5,
        items: [
          { product: "Coca-Cola Soft Drink", qty: 2 },
          { product: "Lucky Me Pancit Canton Original", qty: 5 },
          { product: "SkyFlakes Crackers", qty: 1 },
        ],
      },
      {
        customer: 1, address: 1, store: storeMakati, status: "delivered", payment: "paid",
        placedDaysAgo: 2,
        items: [
          { product: "Nescafé Classic 3-in-1 Coffee", qty: 1 },
          { product: "Milo Chocolate Malt Drink", qty: 1 },
        ],
      },
      {
        customer: 0, address: 0, store: storeQC, status: "out_for_delivery", payment: "paid",
        placedDaysAgo: 0,
        items: [
          { product: "Argentina Corned Beef", qty: 3 },
          { product: "555 Sardines in Tomato Sauce", qty: 4 },
        ],
      },
      {
        customer: 2, address: 2, store: storeMakati, status: "picking", payment: "paid",
        placedDaysAgo: 0,
        items: [
          { product: "Oreo Chocolate Sandwich Cookies", qty: 2 },
          { product: "Del Monte Pineapple Juice", qty: 1 },
        ],
      },
      {
        customer: 1, address: 1, store: storeMakati, status: "confirmed", payment: "pending",
        placedDaysAgo: 0,
        items: [
          { product: "Ariel Powder Detergent Sunrise Fresh", qty: 1 },
          { product: "Joy Dishwashing Liquid Kalamansi", qty: 2 },
        ],
      },
    ];
    for (const [i, o] of orderSeed.entries()) {
      let subtotal = 0;
      const lineItems: {
        product_id: string;
        sku_id: string;
        name: string;
        label: string;
        qty: number;
        unit: number;
        compareAt?: number;
      }[] = [];
      for (const item of o.items) {
        const pid = productIds[item.product];
        const skuId = firstSkuByProduct[pid];
        const seed = products.find((p) => p.name === item.product)!;
        const skuSeed = seed.skus[0];
        subtotal += skuSeed.price * item.qty;
        lineItems.push({
          product_id: pid,
          sku_id: skuId,
          name: item.product,
          label: skuSeed.label,
          qty: item.qty,
          unit: skuSeed.price,
          compareAt: skuSeed.compareAt,
        });
      }
      const deliveryFee = 29;
      const customerDoc = {
        _id: customerIds[o.customer],
        _creationTime: t,
        phone_country_code: "+63",
        phone_number: customerSeed[o.customer]!.phone,
        display_name: customerSeed[o.customer]!.name,
        status: "active",
        marketing_opt_in: true,
        created_at: t,
        updated_at: t,
      } as CustomerDoc;
      const itemCount = lineItems.reduce((sum, li) => sum + li.qty, 0);
      const oid = (await ctx.db.insert("orders", {
        order_number: orderNumber(1000 + i),
        customer_id: customerIds[o.customer],
        store_id: o.store,
        address_id: addressIds[o.address],
        delivery_mode: "express",
        status: o.status,
        payment_status: o.payment,
        currency: "PHP",
        subtotal_amount: subtotal,
        discount_amount: 0,
        delivery_fee_amount: deliveryFee,
        total_amount: subtotal + deliveryFee,
        item_count: itemCount,
        order_search_text: orderSearchText(
          {
            order_number: orderNumber(1000 + i),
          } as OrderDoc,
          customerDoc,
        ),
        orderSummaryVersion: ORDER_SUMMARY_VERSION,
        placed_at: t - o.placedDaysAgo * day - i * 3600_000,
        estimated_delivery_at: t - o.placedDaysAgo * day + 30 * 60_000,
        delivered_at: o.status === "delivered" ? t - o.placedDaysAgo * day + 25 * 60_000 : undefined,
      })) as string;
      // Maintain customer aggregates inline (seed writes bypass the public
      // order mutations).
      const seededOrder = {
        status: o.status,
        total_amount: subtotal + deliveryFee,
      } as OrderDoc;
      const stats = orderCountsForCustomerStats(seededOrder);
      const customerRow = (await ctx.db.get(
        customerIds[o.customer] as any,
      )) as CustomerDoc | null;
      await ctx.db.patch(customerIds[o.customer] as any, {
        order_count: (customerRow?.order_count ?? 0) + stats.order_count,
        total_spend: (customerRow?.total_spend ?? 0) + stats.total_spend,
        customerStatsVersion: CUSTOMER_ORDER_STATS_VERSION,
      });
      for (const li of lineItems) {
        await ctx.db.insert("order_items", {
          order_id: oid,
          product_id: li.product_id,
          sku_id: li.sku_id,
          product_name_snapshot: li.name,
          sku_label_snapshot: li.label,
          quantity: li.qty,
          unit_price: li.unit,
          compare_at_price: li.compareAt,
          line_total: li.unit * li.qty,
        });
      }
      await ctx.db.insert("payments", {
        order_id: oid,
        provider: "cash_on_delivery",
        status: o.payment,
        amount: subtotal + deliveryFee,
        currency: "PHP",
        paid_at: o.payment === "paid" ? t - o.placedDaysAgo * day : undefined,
        created_at: t - o.placedDaysAgo * day,
        updated_at: t,
      });
    }

    // ---- Reviews, ticket, notifications ----
    await ctx.db.insert("reviews", {
      customer_id: customerIds[0],
      product_id: productIds["Coca-Cola Soft Drink"],
      rating: 5,
      title: "Always cold",
      body: "Delivery is fast and the drinks arrive chilled.",
      created_at: t - 4 * day,
    });
    await ctx.db.insert("support_tickets", {
      customer_id: customerIds[1],
      status: "open",
      subject: "Missing item in my order",
      latest_message: "One pack of coffee was missing from my last delivery.",
      created_at: t - day,
      updated_at: t - day,
    });
    for (const cid of customerIds) {
      await ctx.db.insert("notifications", {
        customer_id: cid,
        title: "Payday Sale is on!",
        body: "Up to 15% off beverages and pantry staples this week.",
        deeplink: "pocketmart://promotions/payday",
        created_at: t - day,
      });
    }

    // ---- Maintained list counters (kept exact inline; see listCounts) ----
    const counts = new Map<string, { scope: string; key: string; count: number }>();
    const bump = (scope: string, key: string) => {
      const id = `${scope}${key}`;
      const row = counts.get(id) ?? { scope, key, count: 0 };
      row.count += 1;
      counts.set(id, row);
    };
    for (const product of await ctx.db.query("products").collect()) {
      for (const key of productCountKeys(product)) bump("products", key);
    }
    for (const customer of await ctx.db.query("customers").collect()) {
      for (const key of customerCountKeys(customer)) bump("customers", key);
    }
    for (const order of await ctx.db.query("orders").collect()) {
      for (const key of orderCountKeys(order)) bump("orders", key);
    }
    for (const row of counts.values()) {
      await ctx.db.insert("listCounts", row);
    }

    return {
      seeded: true,
      message: `Seeded ${products.length} products, ${products.reduce((s, p) => s + p.skus.length, 0)} SKUs, 2 stores, ${customerSeed.length} customers, ${orderSeed.length} orders.`,
    };
  },
});
