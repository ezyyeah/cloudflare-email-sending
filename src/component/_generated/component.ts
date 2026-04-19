/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    actions: {
      send: FunctionReference<
        "action",
        "internal",
        {
          config: {
            accountId: string;
            apiBaseUrl: string;
            apiToken: string;
            initialBackoffMs: number;
            maxAttempts: number;
            maxBackoffMs: number;
          };
          request: {
            attachments?: Array<{
              content: string;
              contentId?: string;
              disposition?: "attachment" | "inline";
              filename: string;
              type?: string;
            }>;
            bcc?: string | Array<string>;
            cc?: string | Array<string>;
            from: string | { address: string; name?: string };
            headers?: Record<string, string>;
            html?: string;
            idempotencyKey?: string;
            metadata?: Record<string, string>;
            replyTo?: string | { address: string; name?: string };
            subject: string;
            text?: string;
            to: string | Array<string>;
          };
        },
        any,
        Name
      >;
    };
    mutations: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { emailId: string },
        any,
        Name
      >;
    };
    queries: {
      getStatus: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        any,
        Name
      >;
    };
  };
