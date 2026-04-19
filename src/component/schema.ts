import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vEmailAddress,
  vEmailError,
  vEmailState,
  vProviderAcceptance,
  vPersistedRuntimeConfig,
} from "./shared.js";

export default defineSchema({
  content: defineTable({
    kind: v.union(
      v.literal("html"),
      v.literal("text"),
      v.literal("attachment"),
    ),
    mimeType: v.optional(v.string()),
    filename: v.optional(v.string()),
    storageId: v.string(),
    disposition: v.optional(
      v.union(v.literal("attachment"), v.literal("inline")),
    ),
    contentIdHeader: v.optional(v.string()),
    bytes: v.number(),
    createdAt: v.number(),
  }).index("by_kind", ["kind"]),

  emails: defineTable({
    from: vEmailAddress,
    to: v.array(v.string()),
    cc: v.optional(v.array(v.string())),
    bcc: v.optional(v.array(v.string())),
    replyTo: v.optional(vEmailAddress),
    subject: v.string(),
    htmlContentId: v.optional(v.id("content")),
    textContentId: v.optional(v.id("content")),
    attachmentContentIds: v.optional(v.array(v.id("content"))),
    headers: v.optional(v.record(v.string(), v.string())),
    metadata: v.optional(v.record(v.string(), v.string())),
    idempotencyKey: v.optional(v.string()),
    payloadFingerprint: v.string(),
    runtimeConfig: vPersistedRuntimeConfig,
    estimatedMessageSize: v.number(),
    state: vEmailState,
    attemptCount: v.number(),
    acceptedAt: v.optional(v.number()),
    lastAttemptAt: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    result: v.optional(vProviderAcceptance),
    error: v.optional(vEmailError),
    dispatchReservationId: v.optional(v.string()),
    currentWorkId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    finalizedAt: v.optional(v.number()),
  })
    .index("by_state_nextRetryAt", ["state", "nextRetryAt"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_createdAt", ["createdAt"]),

  attempts: defineTable({
    emailId: v.id("emails"),
    attemptNumber: v.number(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    requestSummary: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    providerCode: v.optional(v.union(v.number(), v.string())),
    responseSummary: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    retryable: v.boolean(),
  })
    .index("by_emailId", ["emailId"])
    .index("by_startedAt", ["startedAt"]),
});
