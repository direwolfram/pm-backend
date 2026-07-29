import { v } from "convex/values";
import { internalMutation } from "./functions";

/**
 * Recovery path for deletion workflows: clears the deleting_at marker so a
 * root whose continuation is blocked by a restrict invariant (e.g. an order
 * created before the mark) is not permanently wedged. Internal only; admins
 * re-run the public remove when the blocker is resolved, or abort here.
 */
export const abortDelete = internalMutation({
  args: {
    table: v.union(
      v.literal("products"),
      v.literal("skus"),
      v.literal("categories"),
      v.literal("brands"),
      v.literal("promotions"),
      v.literal("stores"),
    ),
    id: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id as never);
    if (!doc) return { aborted: false, missing: true };
    if ((doc as { deleting_at?: number }).deleting_at === undefined) {
      return { aborted: false };
    }
    await ctx.db.patch(args.id as never, { deleting_at: undefined } as never);
    return { aborted: true };
  },
});
