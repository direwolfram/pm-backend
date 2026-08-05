import {
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

/**
 * Codegen-free builders. Once you run `npx convex deploy` with your own
 * deployment, codegen kicks in and you may switch these to the typed
 * `query`/`mutation`/`action` from "./_generated/server" — everything else stays.
 */
export const query = queryGeneric;
export const mutation = mutationGeneric;
export const action = actionGeneric;
export const internalMutation = internalMutationGeneric;
export const internalQuery = internalQueryGeneric;
export const internalAction = internalActionGeneric;
