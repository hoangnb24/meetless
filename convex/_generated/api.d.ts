/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as appleSubscription from "../appleSubscription.js";
import type * as deviceAuth from "../deviceAuth.js";
import type * as http from "../http.js";
import type * as managedAuth from "../managedAuth.js";
import type * as managedAuthActions from "../managedAuthActions.js";
import type * as managedAuthValidators from "../managedAuthValidators.js";
import type * as managedCanaryJanitor from "../managedCanaryJanitor.js";
import type * as managedConfig from "../managedConfig.js";
import type * as managedTranscription from "../managedTranscription.js";
import type * as managedTranscriptionActions from "../managedTranscriptionActions.js";
import type * as revenueCatWebhook from "../revenueCatWebhook.js";
import type * as shared from "../shared.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  appleSubscription: typeof appleSubscription;
  deviceAuth: typeof deviceAuth;
  http: typeof http;
  managedAuth: typeof managedAuth;
  managedAuthActions: typeof managedAuthActions;
  managedAuthValidators: typeof managedAuthValidators;
  managedCanaryJanitor: typeof managedCanaryJanitor;
  managedConfig: typeof managedConfig;
  managedTranscription: typeof managedTranscription;
  managedTranscriptionActions: typeof managedTranscriptionActions;
  revenueCatWebhook: typeof revenueCatWebhook;
  shared: typeof shared;
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
