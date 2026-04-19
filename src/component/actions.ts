import type { WorkId } from "@convex-dev/workpool";
import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { decodeBase64, blobToBase64 } from "./encoding.js";
import {
  type ComponentSendEmailArgs,
  type PersistedRuntimeConfig,
  vPersistedRuntimeConfig,
  vSendEmailArgs,
} from "./shared.js";
import { sendWithCloudflare, CloudflareSendFailure } from "./provider.js";
import {
  normalizeSendRequest,
  summarizeProviderError,
  summarizeProviderResponse,
} from "./validation.js";
import { sendWorkpool } from "./workpool.js";

const vDispatchArgs = v.object({
  emailId: v.id("emails"),
});

const vCancelWorkArgs = v.object({
  emailId: v.id("emails"),
  workId: v.string(),
});

export const send = action({
  args: {
    request: vSendEmailArgs,
    config: vPersistedRuntimeConfig,
  },
  handler: sendHandler,
});

export const dispatchQueuedEmail = internalAction({
  args: vDispatchArgs,
  handler: dispatchQueuedEmailHandler,
});

export const processEmail = internalAction({
  args: vDispatchArgs,
  handler: processEmailHandler,
});

export const cancelQueuedWork = internalAction({
  args: vCancelWorkArgs,
  handler: cancelQueuedWorkHandler,
});

type ProcessEmailResult =
  | "missing"
  | "cancelled"
  | "finalized"
  | "already_sending"
  | "terminal_failure"
  | "processed"
  | "needs_reconciliation"
  | "retrying"
  | "failed";

async function sendHandler(
  ctx: ActionCtx,
  args: {
    request: ComponentSendEmailArgs;
    config: PersistedRuntimeConfig;
  },
): Promise<string> {
  const normalized = normalizeSendRequest(args.request);
  const storedContent = await storeRequestContent(ctx, normalized);

  try {
    const result: PersistEmailResult = await ctx.runMutation(
      internal.mutations.persistEmail,
      {
        request: {
          from: normalized.from,
          to: normalized.to,
          cc: normalized.cc.length > 0 ? normalized.cc : undefined,
          bcc: normalized.bcc.length > 0 ? normalized.bcc : undefined,
          replyTo: normalized.replyTo,
          subject: normalized.subject,
          headers: normalized.headers,
          metadata: normalized.metadata,
          idempotencyKey: normalized.idempotencyKey,
          payloadFingerprint: normalized.payloadFingerprint,
          estimatedMessageSize: normalized.estimatedMessageSize,
        },
        content: storedContent.descriptors,
        config: args.config,
      },
    );

    // Kick dispatch immediately for the common path.
    // The scheduled fallback set during persistence remains in place, so if this
    // action is interrupted before dispatch fully starts, the email is still durable.
    await ctx.runAction(internal.actions.dispatchQueuedEmail, {
      emailId: result.emailId,
    });

    if (result.reused) {
      await cleanupStoredContent(ctx, storedContent.storageIds);
    }

    return result.emailId;
  } catch (error) {
    await cleanupStoredContent(ctx, storedContent.storageIds);
    throw error;
  }
}

async function dispatchQueuedEmailHandler(
  ctx: ActionCtx,
  args: { emailId: Id<"emails"> },
): Promise<WorkId | null> {
  const reservationId = createDispatchReservationId(args.emailId);
  const reservation = await ctx.runMutation(internal.mutations.reserveDispatch, {
    emailId: args.emailId,
    reservationId,
  });
  if (reservation.kind !== "reserved") {
    return null;
  }

  let workId: WorkId;
  try {
    workId = await sendWorkpool.enqueueAction(
      ctx,
      internal.actions.processEmail,
      args,
      {
        retry: false,
        name: `cloudflare-email:${args.emailId}`,
      },
    );
  } catch (error) {
    await ctx.runMutation(internal.mutations.releaseDispatchReservation, {
      emailId: args.emailId,
      reservationId,
    });
    throw error;
  }

  const emailState = await ctx.runMutation(
    internal.mutations.activateDispatchedWork,
    {
      emailId: args.emailId,
      reservationId,
      workId,
    },
  );

  if (emailState === "cancelled") {
    await sendWorkpool.cancel(ctx, workId);
    await ctx.runMutation(internal.mutations.clearCurrentWorkId, {
      emailId: args.emailId,
      workId,
    });
  }

  return workId;
}

async function processEmailHandler(
  ctx: ActionCtx,
  args: { emailId: Id<"emails"> },
): Promise<ProcessEmailResult> {
  const preparation: PreparationResult = await ctx.runMutation(
    internal.mutations.prepareAttempt,
    args,
  );
  if (preparation.kind !== "ready") {
    return preparation.kind;
  }

  try {
    const providerRequest = await readProviderRequest(ctx, preparation);
    const response = await sendWithCloudflare(
      preparation.config,
      providerRequest,
    );

    return await finalizeAcceptedAttempt(ctx, {
      emailId: args.emailId,
      attemptId: preparation.attemptId,
      response,
    });
  } catch (error) {
    const failure =
      error instanceof CloudflareSendFailure
        ? error
        : new CloudflareSendFailure(
            error instanceof Error ? error.message : "Email send failed.",
            {
              message:
                error instanceof Error ? error.message : "Email send failed.",
              retryable: false,
            },
          );

    const completion = await ctx.runMutation(
      internal.mutations.completeAttemptFailure,
      {
        emailId: args.emailId,
        attemptId: preparation.attemptId,
        finishedAt: Date.now(),
        error: failure.details,
        responseSummary: summarizeProviderError(failure.response),
      },
    );

    return completion ?? "failed";
  }
}

export async function finalizeAcceptedAttempt(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    emailId: Id<"emails">;
    attemptId: Id<"attempts">;
    response: Awaited<ReturnType<typeof sendWithCloudflare>>;
  },
): Promise<"processed" | "needs_reconciliation"> {
  const finishedAt = Date.now();
  const responseSummary = summarizeProviderResponse(args.response.response);

  try {
    await ctx.runMutation(internal.mutations.completeAttemptSuccess, {
      emailId: args.emailId,
      attemptId: args.attemptId,
      finishedAt,
      httpStatus: args.response.httpStatus,
      acceptance: args.response.acceptance,
      responseSummary,
    });

    return "processed";
  } catch (error) {
    const bookkeepingFailure =
      error instanceof Error ? error.message : "Unknown local bookkeeping error.";
    const errorMessage =
      "Cloudflare accepted the email, but local bookkeeping failed afterwards. " +
      `Reconciliation is required before retrying or resending. Cause: ${bookkeepingFailure}`;
    const completion = await ctx.runMutation(
      internal.mutations.completeAttemptNeedsReconciliation,
      {
        emailId: args.emailId,
        attemptId: args.attemptId,
        finishedAt,
        httpStatus: args.response.httpStatus,
        acceptance: args.response.acceptance,
        responseSummary,
        errorMessage,
      },
    );

    return completion ?? "needs_reconciliation";
  }
}

async function cancelQueuedWorkHandler(
  ctx: ActionCtx,
  args: { emailId: Id<"emails">; workId: string },
): Promise<void> {
  await sendWorkpool.cancel(ctx, args.workId as WorkId);
  await ctx.runMutation(internal.mutations.clearCurrentWorkId, args);
}

async function storeRequestContent(
  ctx: ActionCtx,
  request: ReturnType<typeof normalizeSendRequest>,
) {
  const storageIds: string[] = [];

  const html = request.html
    ? await storeTextContent(ctx, storageIds, request.html, "text/html")
    : undefined;
  const text = request.text
    ? await storeTextContent(ctx, storageIds, request.text, "text/plain")
    : undefined;
  const attachments =
    request.attachments.length > 0
      ? await Promise.all(
          request.attachments.map(async (attachment) => {
            const bytes = decodeBase64(attachment.content);
            const copied = new Uint8Array(bytes.length);
            copied.set(bytes);
            const storageId = await ctx.storage.store(
              new Blob([copied.buffer as ArrayBuffer], {
                type: attachment.type ?? "application/octet-stream",
              }),
            );
            storageIds.push(storageId);
            return {
              storageId,
              bytes: attachment.decodedBytes,
              filename: attachment.filename,
              mimeType: attachment.type ?? "application/octet-stream",
              disposition: attachment.disposition,
              contentIdHeader: attachment.contentId,
            };
          }),
        )
      : [];

  return {
    storageIds,
    descriptors: {
      html,
      text,
      attachments,
    },
  };
}

async function storeTextContent(
  ctx: ActionCtx,
  storageIds: string[],
  content: string,
  mimeType: "text/html" | "text/plain",
) {
  const bytes = new TextEncoder().encode(content).byteLength;
  const storageId = await ctx.storage.store(
    new Blob([content], {
      type: `${mimeType};charset=utf-8`,
    }),
  );
  storageIds.push(storageId);
  return {
    storageId,
    bytes,
    mimeType,
  };
}

async function cleanupStoredContent(ctx: ActionCtx, storageIds: string[]) {
  for (const storageId of storageIds) {
    try {
      await ctx.storage.delete(storageId);
    } catch {
      // Best-effort cleanup only. The durable email record is authoritative.
    }
  }
}

async function readProviderRequest(
  ctx: ActionCtx,
  preparation: ReadyPreparation,
) {
  const html = preparation.htmlContent
    ? await readTextContent(ctx, preparation.htmlContent.storageId)
    : undefined;
  const text = preparation.textContent
    ? await readTextContent(ctx, preparation.textContent.storageId)
    : undefined;
  const attachments = await Promise.all(
    preparation.attachments.map(async (attachment) => {
      const blob = await ctx.storage.get(attachment.storageId);
      if (!blob) {
        throw new CloudflareSendFailure(
          "Stored attachment content is missing.",
          {
            message: "Stored attachment content is missing.",
            retryable: false,
          },
        );
      }

      return {
        filename: attachment.filename,
        content: await blobToBase64(blob),
        type:
          attachment.mimeType || blob.type || "application/octet-stream",
        disposition: attachment.disposition,
        contentId: attachment.contentIdHeader,
      };
    }),
  );

  return {
    from: preparation.from,
    to: preparation.to,
    cc: preparation.cc ?? [],
    bcc: preparation.bcc ?? [],
    replyTo: preparation.replyTo,
    subject: preparation.subject,
    html,
    text,
    headers: preparation.headers,
    attachments,
  };
}

async function readTextContent(ctx: ActionCtx, storageId: string) {
  const blob = await ctx.storage.get(storageId);
  if (!blob) {
    throw new CloudflareSendFailure(
      "Stored email body content is missing.",
      {
        message: "Stored email body content is missing.",
        retryable: false,
      },
    );
  }
  return await blob.text();
}

type ReadyPreparation = {
  kind: "ready";
  attemptId: Id<"attempts">;
  startedAt: number;
  config: PersistedRuntimeConfig;
  from: {
    address: string;
    name?: string;
  };
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: {
    address: string;
    name?: string;
  };
  subject: string;
  headers?: Record<string, string>;
  htmlContent?: {
    storageId: string;
    mimeType?: string;
    bytes: number;
  };
  textContent?: {
    storageId: string;
    mimeType?: string;
    bytes: number;
  };
  attachments: Array<{
    storageId: string;
    filename: string;
    mimeType?: string;
    disposition: "attachment" | "inline";
    contentIdHeader?: string;
  }>;
};

type PreparationResult =
  | {
      kind:
        | "missing"
        | "cancelled"
        | "finalized"
        | "already_sending"
        | "terminal_failure";
    }
  | ReadyPreparation;

type PersistEmailResult = {
  emailId: Id<"emails">;
  reused: boolean;
};

function createDispatchReservationId(emailId: Id<"emails">) {
  return `${emailId}:${crypto.randomUUID()}`;
}
