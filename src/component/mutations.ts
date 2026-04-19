import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  mutation,
  internalMutation,
  type MutationCtx,
} from "./_generated/server.js";
import {
  type EmailError,
  type IdempotencyConflictErrorData,
  SEND_ATTEMPT_RECONCILIATION_DELAY_MS,
  vEmailAddress,
  vEmailError,
  vPersistedRuntimeConfig,
  vProviderAcceptance,
} from "./shared.js";
import { buildAttemptRequestSummary, computeRetryDelayMs } from "./validation.js";

const vStoredTextContent = v.object({
  storageId: v.string(),
  bytes: v.number(),
  mimeType: v.string(),
});

const vStoredAttachmentContent = v.object({
  storageId: v.string(),
  bytes: v.number(),
  filename: v.string(),
  mimeType: v.optional(v.string()),
  disposition: v.union(v.literal("attachment"), v.literal("inline")),
  contentIdHeader: v.optional(v.string()),
});

const vPersistedRequest = v.object({
  from: vEmailAddress,
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  bcc: v.optional(v.array(v.string())),
  replyTo: v.optional(vEmailAddress),
  subject: v.string(),
  headers: v.optional(v.record(v.string(), v.string())),
  metadata: v.optional(v.record(v.string(), v.string())),
  idempotencyKey: v.optional(v.string()),
  payloadFingerprint: v.string(),
  estimatedMessageSize: v.number(),
});

async function storeContentMetadata(
  ctx: MutationCtx,
  kind: "html" | "text" | "attachment",
  createdAt: number,
  content:
    | {
        storageId: string;
        bytes: number;
        mimeType: string;
      }
    | {
        storageId: string;
        bytes: number;
        filename: string;
        mimeType?: string;
        disposition: "attachment" | "inline";
        contentIdHeader?: string;
      },
) {
  return await ctx.db.insert("content", {
    kind,
    storageId: content.storageId,
    bytes: content.bytes,
    mimeType: content.mimeType,
    filename: "filename" in content ? content.filename : undefined,
    disposition: "disposition" in content ? content.disposition : undefined,
    contentIdHeader:
      "contentIdHeader" in content ? content.contentIdHeader : undefined,
    createdAt,
  });
}

async function markAttemptTerminalFailure(
  ctx: MutationCtx,
  args: {
    emailId: string;
    attemptId: string;
    attemptNumber: number;
    startedAt: number;
    error: EmailError;
  },
) {
  const finishedAt = Date.now();
  await ctx.db.patch(args.attemptId as never, {
    finishedAt,
    errorMessage: args.error.message,
    retryable: args.error.retryable,
  });
  await ctx.db.patch(args.emailId as never, {
    state: "failed",
    attemptCount: args.attemptNumber,
    lastAttemptAt: args.startedAt,
    error: args.error,
    updatedAt: finishedAt,
    finalizedAt: finishedAt,
    nextRetryAt: undefined,
    dispatchReservationId: undefined,
    currentWorkId: undefined,
  });
}

export const persistEmail = internalMutation({
  args: {
    request: vPersistedRequest,
    content: v.object({
      html: v.optional(vStoredTextContent),
      text: v.optional(vStoredTextContent),
      attachments: v.array(vStoredAttachmentContent),
    }),
    config: vPersistedRuntimeConfig,
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const persistedRuntimeConfig = args.config;

    if (args.request.idempotencyKey) {
      const existing = await ctx.db
        .query("emails")
        .withIndex("by_idempotencyKey", (query) =>
          query.eq("idempotencyKey", args.request.idempotencyKey),
        )
        .unique();
      if (existing) {
        if (existing.payloadFingerprint !== args.request.payloadFingerprint) {
          throw new ConvexError<IdempotencyConflictErrorData>({
            code: "idempotency_conflict",
            message:
              "This idempotency key has already been used with a different email payload.",
            idempotencyKey: args.request.idempotencyKey,
            existingEmailId: existing._id,
          });
        }

        const shouldDispatch =
          (existing.state === "queued" || existing.state === "retrying") &&
          !existing.currentWorkId &&
          !existing.dispatchReservationId;
        if (shouldDispatch) {
          await ctx.scheduler.runAfter(0, internal.actions.dispatchQueuedEmail, {
            emailId: existing._id,
          });
        }

        return {
          emailId: existing._id,
          reused: true,
        };
      }
    }

    const htmlContentId = args.content.html
      ? await storeContentMetadata(ctx, "html", now, args.content.html)
      : undefined;
    const textContentId = args.content.text
      ? await storeContentMetadata(ctx, "text", now, args.content.text)
      : undefined;
    const attachmentContentIds =
      args.content.attachments.length > 0
        ? await Promise.all(
            args.content.attachments.map((attachment) =>
              storeContentMetadata(ctx, "attachment", now, attachment),
            ),
          )
        : undefined;

    const emailId = await ctx.db.insert("emails", {
      from: args.request.from,
      to: args.request.to,
      cc: args.request.cc,
      bcc: args.request.bcc,
      replyTo: args.request.replyTo,
      subject: args.request.subject,
      htmlContentId,
      textContentId,
      attachmentContentIds,
      headers: args.request.headers,
      metadata: args.request.metadata,
      idempotencyKey: args.request.idempotencyKey,
      payloadFingerprint: args.request.payloadFingerprint,
      runtimeConfig: persistedRuntimeConfig,
      estimatedMessageSize: args.request.estimatedMessageSize,
      state: "queued",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.actions.dispatchQueuedEmail, {
      emailId,
    });

    return {
      emailId,
      reused: false,
    };
  },
});

export const reserveDispatch = internalMutation({
  args: {
    emailId: v.id("emails"),
    reservationId: v.string(),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return { kind: "missing" as const };
    }

    if (email.state !== "queued" && email.state !== "retrying") {
      return {
        kind: "skipped" as const,
        state: email.state,
      };
    }

    if (email.currentWorkId || email.dispatchReservationId) {
      return {
        kind: "skipped" as const,
        state: email.state,
      };
    }

    await ctx.db.patch(args.emailId, {
      dispatchReservationId: args.reservationId,
      updatedAt: Date.now(),
    });
    return {
      kind: "reserved" as const,
      state: email.state,
    };
  },
});

export const activateDispatchedWork = internalMutation({
  args: {
    emailId: v.id("emails"),
    reservationId: v.string(),
    workId: v.string(),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    if (email.dispatchReservationId !== args.reservationId) {
      return email.state;
    }

    const updatedAt = Date.now();
    if (
      email.state === "queued" ||
      email.state === "retrying" ||
      email.state === "cancelled"
    ) {
      await ctx.db.patch(args.emailId, {
        dispatchReservationId: undefined,
        currentWorkId: args.workId,
        updatedAt,
      });
      return email.state;
    }

    await ctx.db.patch(args.emailId, {
      dispatchReservationId: undefined,
      updatedAt,
    });
    return email.state;
  },
});

export const releaseDispatchReservation = internalMutation({
  args: {
    emailId: v.id("emails"),
    reservationId: v.string(),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    if (email.dispatchReservationId !== args.reservationId) {
      return email.dispatchReservationId ?? null;
    }

    await ctx.db.patch(args.emailId, {
      dispatchReservationId: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const clearCurrentWorkId = internalMutation({
  args: {
    emailId: v.id("emails"),
    workId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }
    if (args.workId && email.currentWorkId !== args.workId) {
      return email.currentWorkId ?? null;
    }

    await ctx.db.patch(args.emailId, {
      currentWorkId: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const prepareAttempt = internalMutation({
  args: {
    emailId: v.id("emails"),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return { kind: "missing" as const };
    }
    if (email.state === "cancelled") {
      return { kind: "cancelled" as const };
    }
    if (
      email.state === "processed" ||
      email.state === "needs_reconciliation" ||
      email.state === "failed"
    ) {
      return { kind: "finalized" as const };
    }
    if (email.state === "sending") {
      return { kind: "already_sending" as const };
    }

    const now = Date.now();
    const attemptNumber = email.attemptCount + 1;
    const attemptId = await ctx.db.insert("attempts", {
      emailId: args.emailId,
      attemptNumber,
      startedAt: now,
      requestSummary: buildAttemptRequestSummary({
        to: email.to,
        cc: email.cc ?? [],
        bcc: email.bcc ?? [],
        subject: email.subject,
        headers: email.headers,
        attachments: (email.attachmentContentIds ?? []).map(() => ({
          filename: "",
          content: "",
          disposition: "attachment" as const,
          encodedBytes: 0,
          decodedBytes: 0,
        })),
        html: email.htmlContentId ? "present" : undefined,
        text: email.textContentId ? "present" : undefined,
        estimatedMessageSize: email.estimatedMessageSize,
      }),
      retryable: false,
    });

    const htmlContent = email.htmlContentId
      ? await ctx.db.get(email.htmlContentId)
      : undefined;
    const textContent = email.textContentId
      ? await ctx.db.get(email.textContentId)
      : undefined;
    const attachments = email.attachmentContentIds
      ? await Promise.all(
          email.attachmentContentIds.map((contentId) => ctx.db.get(contentId)),
        )
      : [];

    const missingContent =
      (email.htmlContentId && !htmlContent) ||
      (email.textContentId && !textContent) ||
      attachments.some((attachment) => attachment === null);
    if (missingContent) {
      await markAttemptTerminalFailure(ctx, {
        emailId: args.emailId,
        attemptId,
        attemptNumber,
        startedAt: now,
        error: {
          message: "Persisted email content metadata is missing.",
          retryable: false,
        },
      });
      return { kind: "terminal_failure" as const };
    }

    await ctx.db.patch(args.emailId, {
      state: "sending",
      attemptCount: attemptNumber,
      lastAttemptAt: now,
      nextRetryAt: undefined,
      dispatchReservationId: undefined,
      error: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      SEND_ATTEMPT_RECONCILIATION_DELAY_MS,
      internal.mutations.reconcileStalledAttempt,
      {
        emailId: args.emailId,
        attemptId,
        startedAt: now,
        workId: email.currentWorkId,
      },
    );

    return {
      kind: "ready" as const,
      attemptId,
      startedAt: now,
      config: email.runtimeConfig,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      headers: email.headers,
      htmlContent: htmlContent
        ? {
            storageId: htmlContent.storageId,
            mimeType: htmlContent.mimeType,
            bytes: htmlContent.bytes,
          }
        : undefined,
      textContent: textContent
        ? {
            storageId: textContent.storageId,
            mimeType: textContent.mimeType,
            bytes: textContent.bytes,
          }
        : undefined,
      attachments: attachments.map((attachment) => ({
        storageId: attachment!.storageId,
        filename: attachment!.filename ?? "attachment",
        mimeType: attachment!.mimeType,
        disposition: attachment!.disposition ?? "attachment",
        contentIdHeader: attachment!.contentIdHeader,
      })),
    };
  },
});

export const reconcileStalledAttempt = internalMutation({
  args: {
    emailId: v.id("emails"),
    attemptId: v.id("attempts"),
    startedAt: v.number(),
    workId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return "missing";
    }
    if (email.state !== "sending") {
      return email.state;
    }
    if (email.lastAttemptAt !== args.startedAt) {
      return email.state;
    }
    if (args.workId && email.currentWorkId !== args.workId) {
      return email.state;
    }

    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt || attempt.emailId !== args.emailId) {
      return email.state;
    }
    if (attempt.finishedAt !== undefined || attempt.startedAt !== args.startedAt) {
      return email.state;
    }

    const finishedAt = Date.now();
    const errorMessage =
      "The background send worker stopped before Cloudflare's outcome could be recorded. " +
      "The delivery result is ambiguous, so this email requires reconciliation before retrying or resending.";

    await ctx.db.patch(args.attemptId, {
      finishedAt,
      errorMessage,
      retryable: false,
    });

    await ctx.db.patch(args.emailId, {
      state: "needs_reconciliation",
      error: {
        message: errorMessage,
        retryable: false,
      },
      dispatchReservationId: undefined,
      currentWorkId: undefined,
      nextRetryAt: undefined,
      updatedAt: finishedAt,
      finalizedAt: finishedAt,
    });

    return "needs_reconciliation";
  },
});

export const completeAttemptSuccess = internalMutation({
  args: {
    emailId: v.id("emails"),
    attemptId: v.id("attempts"),
    finishedAt: v.number(),
    httpStatus: v.number(),
    acceptance: vProviderAcceptance,
    responseSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptId, {
      finishedAt: args.finishedAt,
      httpStatus: args.httpStatus,
      responseSummary: args.responseSummary,
      retryable: false,
      errorMessage: undefined,
    });

    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    await ctx.db.patch(args.emailId, {
      state: "processed",
      acceptedAt: args.finishedAt,
      result: args.acceptance,
      error: undefined,
      dispatchReservationId: undefined,
      currentWorkId: undefined,
      nextRetryAt: undefined,
      updatedAt: args.finishedAt,
      finalizedAt: args.finishedAt,
    });
    return "processed";
  },
});

export const completeAttemptNeedsReconciliation = internalMutation({
  args: {
    emailId: v.id("emails"),
    attemptId: v.id("attempts"),
    finishedAt: v.number(),
    httpStatus: v.number(),
    acceptance: vProviderAcceptance,
    responseSummary: v.optional(v.string()),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptId, {
      finishedAt: args.finishedAt,
      httpStatus: args.httpStatus,
      responseSummary: args.responseSummary,
      retryable: false,
      errorMessage: args.errorMessage,
    });

    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    await ctx.db.patch(args.emailId, {
      state: "needs_reconciliation",
      acceptedAt: args.finishedAt,
      result: args.acceptance,
      error: {
        message: args.errorMessage,
        retryable: false,
      },
      dispatchReservationId: undefined,
      currentWorkId: undefined,
      nextRetryAt: undefined,
      updatedAt: args.finishedAt,
      finalizedAt: args.finishedAt,
    });
    return "needs_reconciliation";
  },
});

export const completeAttemptFailure = internalMutation({
  args: {
    emailId: v.id("emails"),
    attemptId: v.id("attempts"),
    finishedAt: v.number(),
    error: vEmailError,
    responseSummary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptId, {
      finishedAt: args.finishedAt,
      httpStatus: args.error.httpStatus,
      providerCode: args.error.code,
      responseSummary: args.responseSummary,
      errorMessage: args.error.message,
      retryable: args.error.retryable,
    });

    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }
    if (email.state === "needs_reconciliation") {
      return "needs_reconciliation";
    }
    if (email.state === "cancelled") {
      await ctx.db.patch(args.emailId, {
        dispatchReservationId: undefined,
        currentWorkId: undefined,
        updatedAt: args.finishedAt,
      });
      return "cancelled";
    }

    const shouldRetry =
      args.error.retryable &&
      email.attemptCount < email.runtimeConfig.maxAttempts;

    if (shouldRetry) {
      const delayMs = computeRetryDelayMs(
        email.runtimeConfig,
        email.attemptCount,
        String(args.emailId),
      );
      const nextRetryAt = args.finishedAt + delayMs;
      await ctx.db.patch(args.emailId, {
        state: "retrying",
        error: args.error,
        dispatchReservationId: undefined,
        currentWorkId: undefined,
        nextRetryAt,
        updatedAt: args.finishedAt,
        finalizedAt: undefined,
      });
      await ctx.scheduler.runAfter(delayMs, internal.actions.dispatchQueuedEmail, {
        emailId: args.emailId,
      });
      return "retrying";
    }

    await ctx.db.patch(args.emailId, {
      state: "failed",
      error: args.error,
      dispatchReservationId: undefined,
      currentWorkId: undefined,
      nextRetryAt: undefined,
      updatedAt: args.finishedAt,
      finalizedAt: args.finishedAt,
    });
    return "failed";
  },
});

export const cancel = mutation({
  args: {
    emailId: v.id("emails"),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    if (
      email.state === "processed" ||
      email.state === "needs_reconciliation" ||
      email.state === "failed"
    ) {
      return email.state;
    }
    if (email.state === "sending") {
      return "sending";
    }
    if (email.state === "cancelled") {
      return "cancelled";
    }

    const now = Date.now();
    await ctx.db.patch(args.emailId, {
      state: "cancelled",
      nextRetryAt: undefined,
      currentWorkId: email.currentWorkId,
      updatedAt: now,
      finalizedAt: now,
    });

    if (email.currentWorkId) {
      await ctx.scheduler.runAfter(0, internal.actions.cancelQueuedWork, {
        emailId: args.emailId,
        workId: email.currentWorkId,
      });
    }

    return "cancelled";
  },
});
