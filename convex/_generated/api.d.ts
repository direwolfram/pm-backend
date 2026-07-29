/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as brands from "../brands.js";
import type * as cascades from "../cascades.js";
import type * as categories from "../categories.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as functions from "../functions.js";
import type * as helpers from "../helpers.js";
import type * as homeSections from "../homeSections.js";
import type * as inventory from "../inventory.js";
import type * as lib_customerAggregates from "../lib/customerAggregates.js";
import type * as lib_customerSearchTokens from "../lib/customerSearchTokens.js";
import type * as lib_dashboardMetrics from "../lib/dashboardMetrics.js";
import type * as lib_geo from "../lib/geo.js";
import type * as lib_inventoryMath from "../lib/inventoryMath.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_productListSummaries from "../lib/productListSummaries.js";
import type * as lib_productSearchTokens from "../lib/productSearchTokens.js";
import type * as listCounts from "../listCounts.js";
import type * as model from "../model.js";
import type * as orders from "../orders.js";
import type * as prices from "../prices.js";
import type * as products from "../products.js";
import type * as promotions from "../promotions.js";
import type * as quickInventory from "../quickInventory.js";
import type * as quickInventorySeed from "../quickInventorySeed.js";
import type * as seed from "../seed.js";
import type * as skus from "../skus.js";
import type * as stores from "../stores.js";
import type * as types_inventory from "../types/inventory.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  brands: typeof brands;
  cascades: typeof cascades;
  categories: typeof categories;
  crons: typeof crons;
  customers: typeof customers;
  dashboard: typeof dashboard;
  functions: typeof functions;
  helpers: typeof helpers;
  homeSections: typeof homeSections;
  inventory: typeof inventory;
  "lib/customerAggregates": typeof lib_customerAggregates;
  "lib/customerSearchTokens": typeof lib_customerSearchTokens;
  "lib/dashboardMetrics": typeof lib_dashboardMetrics;
  "lib/geo": typeof lib_geo;
  "lib/inventoryMath": typeof lib_inventoryMath;
  "lib/pricing": typeof lib_pricing;
  "lib/productListSummaries": typeof lib_productListSummaries;
  "lib/productSearchTokens": typeof lib_productSearchTokens;
  listCounts: typeof listCounts;
  model: typeof model;
  orders: typeof orders;
  prices: typeof prices;
  products: typeof products;
  promotions: typeof promotions;
  quickInventory: typeof quickInventory;
  quickInventorySeed: typeof quickInventorySeed;
  seed: typeof seed;
  skus: typeof skus;
  stores: typeof stores;
  "types/inventory": typeof types_inventory;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
