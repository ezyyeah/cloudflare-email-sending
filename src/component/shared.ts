import { v } from "convex/values";

export const DEFAULT_CLOUDFLARE_EMAIL_MOUNT_NAME = "cloudflareEmail";
export const SEND_WORKPOOL_MOUNT_NAME = "sendWorkpool";
export const MAX_CLOUDFLARE_RECIPIENTS = 50;
export const MAX_CLOUDFLARE_SUBJECT_LENGTH = 998;
export const MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES = 25 * 1024 * 1024;
export const MAX_CLOUDFLARE_HEADERS_BYTES = 16 * 1024;
export const MAX_CLOUDFLARE_HEADER_NAME_BYTES = 100;
export const MAX_CLOUDFLARE_HEADER_VALUE_BYTES = 2048;
export const MAX_CLOUDFLARE_WHITELISTED_HEADERS = 20;
export const SEND_ATTEMPT_RECONCILIATION_DELAY_MS = 15 * 60 * 1000;

export const EMAIL_STATES = [
  "queued",
  "sending",
  "retrying",
  "processed",
  "needs_reconciliation",
  "failed",
  "cancelled",
] as const;

export type EmailState = (typeof EMAIL_STATES)[number];

export type EmailAddress = {
  address: string;
  name?: string;
};

export type EmailAddressInput = string | EmailAddress;

export type EmailAttachmentInput = {
  filename: string;
  content: string;
  type?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

export type ComponentSendEmailArgs = {
  from: EmailAddressInput;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: EmailAddressInput;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachmentInput[];
  idempotencyKey?: string;
  metadata?: Record<string, string>;
};

export type ProviderAcceptance = {
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
};

export type EmailError = {
  httpStatus?: number;
  code?: number | string;
  message: string;
  retryable: boolean;
};

export type IdempotencyConflictErrorData<EmailId = string> = {
  code: "idempotency_conflict";
  message: string;
  idempotencyKey: string;
  existingEmailId: EmailId;
};

export type CloudflareCredentials = {
  accountId: string;
  apiToken: string;
};

export type OperationalConfig = {
  apiBaseUrl: string;
  initialBackoffMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
};

export type RuntimeConfig = CloudflareCredentials & OperationalConfig;

export type PersistedRuntimeConfig = RuntimeConfig;

export type EmailStatus<EmailId = string> = {
  id: EmailId;
  state: EmailState;
  acceptedAt?: number;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  attemptCount: number;
  result?: ProviderAcceptance;
  error?: EmailError;
  metadata?: Record<string, string>;
};

export const vEmailState = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("retrying"),
  v.literal("processed"),
  v.literal("needs_reconciliation"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const vEmailAddress = v.object({
  address: v.string(),
  name: v.optional(v.string()),
});

export const vEmailAddressInput = v.union(v.string(), vEmailAddress);

export const vRecipientList = v.union(v.string(), v.array(v.string()));

export const vAttachmentInput = v.object({
  filename: v.string(),
  content: v.string(),
  type: v.optional(v.string()),
  disposition: v.optional(v.union(v.literal("attachment"), v.literal("inline"))),
  contentId: v.optional(v.string()),
});

export const vProviderAcceptance = v.object({
  delivered: v.array(v.string()),
  queued: v.array(v.string()),
  permanentBounces: v.array(v.string()),
});

export const vEmailError = v.object({
  httpStatus: v.optional(v.number()),
  code: v.optional(v.union(v.number(), v.string())),
  message: v.string(),
  retryable: v.boolean(),
});

export const vOperationalConfig = v.object({
  apiBaseUrl: v.string(),
  initialBackoffMs: v.number(),
  maxAttempts: v.number(),
  maxBackoffMs: v.number(),
});

export const vCloudflareCredentials = v.object({
  accountId: v.string(),
  apiToken: v.string(),
});

export const vPersistedRuntimeConfig = v.object({
  accountId: v.string(),
  apiToken: v.string(),
  apiBaseUrl: v.string(),
  initialBackoffMs: v.number(),
  maxAttempts: v.number(),
  maxBackoffMs: v.number(),
});

export const vSendEmailArgs = v.object({
  from: vEmailAddressInput,
  to: vRecipientList,
  cc: v.optional(vRecipientList),
  bcc: v.optional(vRecipientList),
  replyTo: v.optional(vEmailAddressInput),
  subject: v.string(),
  html: v.optional(v.string()),
  text: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
  attachments: v.optional(v.array(vAttachmentInput)),
  idempotencyKey: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.string())),
});
