import { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";

const rawUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const url = rawUrl?.replace(/\/+$/, "");

/** Loopback URLs only exist inside a dev sandbox — treat as unconfigured. */
export const isConvexConfigured =
  !!url && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url);

export const convexClient = isConvexConfigured
  ? new ConvexReactClient(url!)
  : null;

/**
 * Codegen-free API handle. Once you run `npx convex deploy` with your own
 * deployment you can swap this for the typed `api` from convex/_generated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const api: any = anyApi;
