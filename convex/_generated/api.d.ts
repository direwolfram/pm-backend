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
import type * as categories from "../categories.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as functions from "../functions.js";
import type * as helpers from "../helpers.js";
import type * as homeSections from "../homeSections.js";
import type * as inventory from "../inventory.js";
import type * as model from "../model.js";
import type * as orders from "../orders.js";
import type * as prices from "../prices.js";
import type * as products from "../products.js";
import type * as promotions from "../promotions.js";
import type * as seed from "../seed.js";
import type * as skus from "../skus.js";
import type * as stores from "../stores.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  brands: typeof brands;
  categories: typeof categories;
  customers: typeof customers;
  dashboard: typeof dashboard;
  functions: typeof functions;
  helpers: typeof helpers;
  homeSections: typeof homeSections;
  inventory: typeof inventory;
  model: typeof model;
  orders: typeof orders;
  prices: typeof prices;
  products: typeof products;
  promotions: typeof promotions;
  seed: typeof seed;
  skus: typeof skus;
  stores: typeof stores;
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
