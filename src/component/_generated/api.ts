/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as config from "../config.js";
import type * as encoding from "../encoding.js";
import type * as mutations from "../mutations.js";
import type * as provider from "../provider.js";
import type * as queries from "../queries.js";
import type * as shared from "../shared.js";
import type * as validation from "../validation.js";
import type * as workpool from "../workpool.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  actions: typeof actions;
  config: typeof config;
  encoding: typeof encoding;
  mutations: typeof mutations;
  provider: typeof provider;
  queries: typeof queries;
  shared: typeof shared;
  validation: typeof validation;
  workpool: typeof workpool;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  sendWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"sendWorkpool">;
};
