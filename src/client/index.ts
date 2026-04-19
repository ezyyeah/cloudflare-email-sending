import type { Id } from "../component/_generated/dataModel.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type {
  AnyDataModel,
  GenericActionCtx,
  GenericQueryCtx,
} from "convex/server";
import {
  resolveOperationalConfig,
  resolveRuntimeConfig,
  type OperationalConfigOptions,
  type RuntimeConfigOptions,
} from "../component/config.js";
import { blobToBase64 } from "../component/encoding.js";
import type {
  ComponentSendEmailArgs,
  EmailAddress,
  EmailAddressInput,
  EmailAttachmentInput,
  EmailError,
  EmailState,
  EmailStatus,
  IdempotencyConflictErrorData,
  OperationalConfig,
  ProviderAcceptance,
} from "../component/shared.js";

export type CloudflareEmailComponent = ComponentApi;
export type EmailId = Id<"emails">;
export type CloudflareEmailOptions = RuntimeConfigOptions;
export type StorageBackedAttachmentInput = {
  filename: string;
  storageId: string;
  type?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};
export type SendEmailArgs = Omit<ComponentSendEmailArgs, "attachments"> & {
  attachments?: Array<EmailAttachmentInput | StorageBackedAttachmentInput>;
};

export type {
  EmailAddress,
  EmailAddressInput,
  EmailAttachmentInput,
  EmailError,
  EmailState,
  EmailStatus,
  IdempotencyConflictErrorData,
  OperationalConfig,
  ProviderAcceptance,
};

type RunSendCtx = Pick<GenericActionCtx<AnyDataModel>, "runAction" | "storage">;
type RunMutationCtx = Pick<GenericActionCtx<AnyDataModel>, "runMutation">;
type RunQueryCtx = Pick<GenericQueryCtx<AnyDataModel>, "runQuery">;

export class IdempotencyConflictError<EmailIdType = string> extends Error {
  readonly code = "idempotency_conflict";

  constructor(readonly data: IdempotencyConflictErrorData<EmailIdType>) {
    super(data.message);
    this.name = "IdempotencyConflictError";
  }
}

export class CloudflareEmail {
  private readonly actions: NonNullable<CloudflareEmailComponent["actions"]>;
  private readonly mutations: NonNullable<CloudflareEmailComponent["mutations"]>;
  private readonly queries: NonNullable<CloudflareEmailComponent["queries"]>;

  constructor(
    component: CloudflareEmailComponent,
    private readonly options?: CloudflareEmailOptions,
  ) {
    if (!component?.actions || !component?.mutations || !component?.queries) {
      throw new Error(
        "Cloudflare Email component reference is required. Mount the component in convex.config.ts and pass components.cloudflareEmail.",
      );
    }

    this.actions = component.actions;
    this.mutations = component.mutations;
    this.queries = component.queries;
  }

  get config(): OperationalConfig {
    return resolveOperationalConfig(this.options);
  }

  get runtimeConfig() {
    return resolveRuntimeConfig(this.options);
  }

  async send(ctx: RunSendCtx, request: SendEmailArgs): Promise<EmailId> {
    const resolvedRequest = await resolveSendRequest(ctx, request);

    try {
      return (await ctx.runAction(this.actions.send, {
        request: resolvedRequest,
        config: this.runtimeConfig,
      })) as EmailId;
    } catch (error) {
      throw maybeMapConflict(error);
    }
  }

  async getStatus(
    ctx: RunQueryCtx,
    emailId: EmailId,
  ): Promise<EmailStatus<EmailId> | null> {
    return (await ctx.runQuery(this.queries.getStatus, {
      emailId,
    })) as EmailStatus<EmailId> | null;
  }

  async cancel(
    ctx: RunMutationCtx,
    emailId: EmailId,
  ): Promise<EmailState | null> {
    return (await ctx.runMutation(this.mutations.cancel, {
      emailId,
    })) as EmailState | null;
  }
}

async function resolveSendRequest(
  ctx: RunSendCtx,
  request: SendEmailArgs,
): Promise<ComponentSendEmailArgs> {
  const attachments =
    request.attachments && request.attachments.length > 0
      ? await Promise.all(
          request.attachments.map(async (attachment) => {
            if (!("storageId" in attachment)) {
              return attachment;
            }

            if (attachment.filename.trim().length === 0) {
              throw new Error("storage-backed attachments require a filename.");
            }

            const blob = await ctx.storage.get(attachment.storageId);
            if (!blob) {
              throw new Error(
                `Storage attachment '${attachment.storageId}' could not be read.`,
              );
            }

            return {
              filename: attachment.filename,
              content: await blobToBase64(blob),
              type:
                attachment.type || blob.type || "application/octet-stream",
              disposition: attachment.disposition,
              contentId: attachment.contentId,
            } satisfies EmailAttachmentInput;
          }),
        )
      : undefined;

  return {
    ...request,
    attachments,
  };
}

function maybeMapConflict(error: unknown): unknown {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (
    data &&
    typeof data === "object" &&
    "code" in data &&
    data.code === "idempotency_conflict"
  ) {
    return new IdempotencyConflictError(data as IdempotencyConflictErrorData);
  }
  return error;
}
