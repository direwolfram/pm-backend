import { v } from "convex/values";
import { anyApi } from "convex/server";
import { action, internalMutation, internalQuery } from "./functions";
import { now } from "./helpers";
import type { Id } from "./_generated/dataModel";
import type { ProductDoc, ProductMediaDoc } from "./model";

const MAX_BATCH_SIZE = 25;
const FETCH_TIMEOUT_MS = 9000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36";

type CandidateProduct = {
  id: Id<"products">;
  name: string;
  brand?: string;
  media: Array<{
    id: Id<"product_media">;
    url: string;
    is_showcase?: boolean;
    sort_order: number;
  }>;
};

function isPlaceholderUrl(url: string | undefined) {
  if (!url) return true;
  const normalized = url.toLowerCase();
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return (
    hostname === "placehold.co" ||
    hostname.endsWith(".placehold.co") ||
    normalized.includes("placeholder") ||
    normalized.includes("dummy") ||
    normalized.includes("slide%20") ||
    normalized.includes("slide+")
  );
}

function currentShowcase(media: CandidateProduct["media"]) {
  const sorted = [...media].sort((a, b) => a.sort_order - b.sort_order);
  return sorted.find((item) => item.is_showcase) ?? sorted[0];
}

function productNeedsImage(product: CandidateProduct, override: boolean) {
  if (override) return true;
  return isPlaceholderUrl(currentShowcase(product.media)?.url);
}

function cleanQueryPart(value: string) {
  return value
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function imageQueries(product: Pick<CandidateProduct, "name" | "brand">) {
  const brand = cleanQueryPart(product.brand ?? "");
  const name = cleanQueryPart(product.name);
  const brandedName = brand && !name.toLowerCase().includes(brand.toLowerCase())
    ? `${brand} ${name}`
    : name;
  return [
    `${brandedName} product image`,
    `${brandedName} packshot`,
    `${brandedName} grocery product Philippines`,
  ];
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json,text/html,*/*",
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractDuckDuckGoToken(html: string) {
  return (
    html.match(/vqd=['"]([^'"]+)['"]/)?.[1] ??
    html.match(/vqd=([^&"']+)/)?.[1]
  );
}

function imageUrlLooksUsable(url: unknown) {
  if (typeof url !== "string") return false;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  const lower = url.toLowerCase();
  if (lower.startsWith("http://")) return false;
  if (lower.includes("logo") || lower.includes("icon") || lower.includes("sprite")) return false;
  if (lower.endsWith(".svg") || lower.endsWith(".gif")) return false;
  return true;
}

type DuckDuckGoImage = {
  image?: string;
  title?: string;
  url?: string;
  width?: number;
  height?: number;
};

async function scrapeDuckDuckGoImage(query: string) {
  const searchUrl = `https://duckduckgo.com/?${new URLSearchParams({
    q: query,
    iax: "images",
    ia: "images",
  })}`;
  const searchResponse = await fetchWithTimeout(searchUrl);
  if (!searchResponse.ok) return null;

  const token = extractDuckDuckGoToken(await searchResponse.text());
  if (!token) return null;

  const imageUrl = `https://duckduckgo.com/i.js?${new URLSearchParams({
    l: "us-en",
    o: "json",
    q: query,
    vqd: token,
    f: ",,,",
    p: "1",
  })}`;
  const imageResponse = await fetchWithTimeout(imageUrl, {
    headers: { referer: searchUrl },
  });
  if (!imageResponse.ok) return null;

  const body = (await imageResponse.json()) as { results?: DuckDuckGoImage[] };
  const candidates = body.results ?? [];
  for (const candidate of candidates) {
    if (!imageUrlLooksUsable(candidate.image)) continue;
    const width = candidate.width ?? 0;
    const height = candidate.height ?? 0;
    if (width && height && (width < 220 || height < 220)) continue;
    return {
      imageUrl: candidate.image!,
      sourceUrl: imageUrlLooksUsable(candidate.url) ? candidate.url : undefined,
      sourceTitle: candidate.title,
    };
  }
  return null;
}

export const imageCandidates = internalQuery({
  args: {
    productId: v.optional(v.id("products")),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    override: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_BATCH_SIZE);
    const override = args.override ?? false;

    if (args.productId) {
      const product = (await ctx.db.get(args.productId)) as ProductDoc | null;
      if (!product) {
        return { products: [], nextCursor: null, done: true };
      }
      const media = (await ctx.db
        .query("product_media")
        .withIndex("by_product", (q) => q.eq("product_id", args.productId))
        .collect()) as ProductMediaDoc[];
      const candidate = {
        id: product._id as Id<"products">,
        name: product.name,
        brand: product.brand,
        media: media.map((item) => ({
          id: item._id as Id<"product_media">,
          url: item.url,
          is_showcase: item.is_showcase,
          sort_order: item.sort_order,
        })),
      };
      return {
        products: productNeedsImage(candidate, override) ? [candidate] : [],
        nextCursor: null,
        done: true,
      };
    }

    const page = await ctx.db
      .query("products")
      .order("asc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    const products: CandidateProduct[] = [];
    for (const product of page.page as ProductDoc[]) {
      const media = (await ctx.db
        .query("product_media")
        .withIndex("by_product", (q) => q.eq("product_id", product._id as Id<"products">))
        .collect()) as ProductMediaDoc[];
      const candidate = {
        id: product._id as Id<"products">,
        name: product.name,
        brand: product.brand,
        media: media.map((item) => ({
          id: item._id as Id<"product_media">,
          url: item.url,
          is_showcase: item.is_showcase,
          sort_order: item.sort_order,
        })),
      };
      if (productNeedsImage(candidate, override)) products.push(candidate);
    }

    return {
      products,
      nextCursor: page.continueCursor,
      done: page.isDone,
      scanned: page.page.length,
    };
  },
});

export const prependFoundImage = internalMutation({
  args: {
    productId: v.id("products"),
    imageUrl: v.string(),
    altText: v.string(),
    override: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const product = (await ctx.db.get(args.productId)) as ProductDoc | null;
    if (!product) return { updated: false, reason: "Product not found" };

    const media = ((await ctx.db
      .query("product_media")
      .withIndex("by_product", (q) => q.eq("product_id", args.productId))
      .collect()) as ProductMediaDoc[]).sort((a, b) => a.sort_order - b.sort_order);
    const showcase = media.find((item) => item.is_showcase) ?? media[0];
    if (!args.override && showcase && !isPlaceholderUrl(showcase.url)) {
      return { updated: false, reason: "Product already has a non-placeholder showcase" };
    }

    const existing = media.find((item) => item.url === args.imageUrl);
    const targetId =
      existing?._id ??
      ((await ctx.db.insert("product_media", {
        product_id: args.productId,
        url: args.imageUrl,
        alt_text: args.altText,
        is_showcase: true,
        sort_order: 0,
      })) as Id<"product_media">);

    await ctx.db.patch(targetId, {
      alt_text: args.altText,
      is_showcase: true,
      sort_order: 0,
    });

    let nextSort = 1;
    for (const item of media) {
      if (item._id === targetId) continue;
      await ctx.db.patch(item._id as Id<"product_media">, {
        is_showcase: false,
        sort_order: nextSort,
      });
      nextSort += 1;
    }

    const currentImages = Array.isArray(product.images) ? product.images : [];
    await ctx.db.patch(args.productId, {
      images: [args.imageUrl, ...currentImages.filter((url) => url !== args.imageUrl)],
      updated_at: now(),
    });

    return { updated: true };
  },
});

export const scrapeAndPrependImages = action({
  args: {
    productId: v.optional(v.id("products")),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    override: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_BATCH_SIZE);
    const override = args.override ?? false;
    const page = (await ctx.runQuery(anyApi.productImageScrape.imageCandidates, {
      productId: args.productId,
      cursor: args.cursor ?? null,
      limit,
      override,
    })) as {
      products: CandidateProduct[];
      nextCursor: string | null;
      done: boolean;
      scanned?: number;
    };

    const results: Array<{
      productId: string;
      name: string;
      status: "updated" | "not_found" | "skipped";
      imageUrl?: string;
      sourceUrl?: string;
      query?: string;
      reason?: string;
    }> = [];

    for (const product of page.products) {
      let found:
        | { imageUrl: string; sourceUrl?: string; sourceTitle?: string; query: string }
        | null = null;
      for (const query of imageQueries(product)) {
        const scraped = await scrapeDuckDuckGoImage(query);
        if (!scraped) continue;
        found = { ...scraped, query };
        break;
      }

      if (!found) {
        results.push({
          productId: product.id,
          name: product.name,
          status: "not_found",
          reason: "No usable image result returned",
        });
        continue;
      }

      const mutationResult = (await ctx.runMutation(anyApi.productImageScrape.prependFoundImage, {
        productId: product.id,
        imageUrl: found.imageUrl,
        altText: found.sourceTitle
          ? `${product.name} product image - ${found.sourceTitle}`
          : `${product.name} product image`,
        override,
      })) as { updated: boolean; reason?: string };

      results.push({
        productId: product.id,
        name: product.name,
        status: mutationResult.updated ? "updated" : "skipped",
        imageUrl: found.imageUrl,
        sourceUrl: found.sourceUrl,
        query: found.query,
        reason: mutationResult.reason,
      });
    }

    return {
      nextCursor: page.nextCursor,
      done: page.done,
      scanned: args.productId ? 1 : (page.scanned ?? limit),
      candidates: page.products.length,
      updated: results.filter((result) => result.status === "updated").length,
      notFound: results.filter((result) => result.status === "not_found").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      results,
    };
  },
});
