import type {
  ComponentSendEmailArgs,
  EmailAddress,
  EmailAddressInput,
  PersistedRuntimeConfig,
} from "./shared.js";
import {
  MAX_CLOUDFLARE_HEADER_NAME_BYTES,
  MAX_CLOUDFLARE_HEADER_VALUE_BYTES,
  MAX_CLOUDFLARE_HEADERS_BYTES,
  MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES,
  MAX_CLOUDFLARE_RECIPIENTS,
  MAX_CLOUDFLARE_SUBJECT_LENGTH,
  MAX_CLOUDFLARE_WHITELISTED_HEADERS,
} from "./shared.js";
import { estimateBase64DecodedBytes, normalizeBase64 } from "./encoding.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHITELISTED_HEADERS = new Map(
  [
    "In-Reply-To",
    "References",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "List-Id",
    "List-Archive",
    "List-Help",
    "List-Owner",
    "List-Post",
    "List-Subscribe",
    "Precedence",
    "Auto-Submitted",
    "Content-Language",
    "Keywords",
    "Comments",
    "Importance",
    "Sensitivity",
    "Organization",
    "Require-Recipient-Valid-Since",
    "Archived-At",
  ].map((header) => [header.toLowerCase(), header]),
);
const API_FIELD_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
]);
const PLATFORM_CONTROLLED_HEADERS = new Set([
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
  "return-path",
  "received",
  "feedback-id",
  "tls-required",
  "tls-report-domain",
  "tls-report-submitter",
  "cfbl-address",
  "cfbl-feedback-id",
]);
const X_HEADER_PATTERN = /^X-[A-Za-z0-9\-_]+$/;
const STANDARD_HEADER_PATTERN = /^[A-Za-z0-9-]+$/;
const LIST_UNSUBSCRIBE_URI_PATTERN = /<((https:\/\/|mailto:)[^>]+)>/g;

export type NormalizedAttachment = {
  filename: string;
  content: string;
  type?: string;
  disposition: "attachment" | "inline";
  contentId?: string;
  encodedBytes: number;
  decodedBytes: number;
};

export type NormalizedSendEmailRequest = {
  from: EmailAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments: NormalizedAttachment[];
  idempotencyKey?: string;
  metadata?: Record<string, string>;
  payloadFingerprint: string;
  estimatedMessageSize: number;
};

export function normalizeSendRequest(
  request: ComponentSendEmailArgs,
): NormalizedSendEmailRequest {
  const from = normalizeEmailAddress(request.from, "from");
  const to = normalizeRecipients(request.to, "to");
  const cc = normalizeRecipients(request.cc, "cc");
  const bcc = normalizeRecipients(request.bcc, "bcc");
  const replyTo = request.replyTo
    ? normalizeEmailAddress(request.replyTo, "replyTo")
    : undefined;
  const subject = request.subject.trim();
  const html = normalizeOptionalBody(request.html, "html");
  const text = normalizeOptionalBody(request.text, "text");
  const headers = normalizeHeaders(request.headers);
  const attachments = normalizeAttachments(request.attachments);
  const metadata = normalizeStringRecord(request.metadata, "metadata");
  const idempotencyKey = normalizeOptionalString(
    request.idempotencyKey,
    "idempotencyKey",
  );

  if (subject.length === 0) {
    throw new Error("subject must not be empty.");
  }
  if (subject.length > MAX_CLOUDFLARE_SUBJECT_LENGTH) {
    throw new Error(
      `subject must be at most ${MAX_CLOUDFLARE_SUBJECT_LENGTH} characters.`,
    );
  }
  if (!html && !text) {
    throw new Error("At least one of html or text must be provided.");
  }

  if (to.length === 0) {
    throw new Error("At least one recipient is required in to.");
  }

  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount > MAX_CLOUDFLARE_RECIPIENTS) {
    throw new Error(
      `A maximum of ${MAX_CLOUDFLARE_RECIPIENTS} recipients is allowed across to, cc, and bcc.`,
    );
  }

  const canonicalPayload = {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      type: attachment.type,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
    })),
    idempotencyKey,
    metadata,
  };
  const payloadFingerprint = fnv1aHash(stableStringify(canonicalPayload));
  const estimatedMessageSize = estimateMessageSize({
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments,
  });

  if (estimatedMessageSize > MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES) {
    throw new Error(
      `Estimated message size exceeds the ${formatBytes(MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES)} Cloudflare limit.`,
    );
  }

  return {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments,
    idempotencyKey,
    metadata,
    payloadFingerprint,
    estimatedMessageSize,
  };
}

export function computeRetryDelayMs(
  config: Pick<
    PersistedRuntimeConfig,
    "initialBackoffMs" | "maxBackoffMs"
  >,
  attemptNumber: number,
  seed: string,
): number {
  const exponent = Math.max(attemptNumber - 1, 0);
  const uncapped = config.initialBackoffMs * 2 ** exponent;
  const capped = Math.min(uncapped, config.maxBackoffMs);
  const jitter = 0.5 + hashToUnitInterval(`${seed}:${attemptNumber}`) * 0.5;
  return Math.max(1_000, Math.round(capped * jitter));
}

export function buildAttemptRequestSummary(
  request: Pick<
    NormalizedSendEmailRequest,
    | "to"
    | "cc"
    | "bcc"
    | "subject"
    | "headers"
    | "attachments"
    | "html"
    | "text"
    | "estimatedMessageSize"
  >,
): string {
  return JSON.stringify({
    toCount: request.to.length,
    ccCount: request.cc.length,
    bccCount: request.bcc.length,
    subject: request.subject,
    headerCount: Object.keys(request.headers ?? {}).length,
    attachmentCount: request.attachments.length,
    hasHtml: Boolean(request.html),
    hasText: Boolean(request.text),
    estimatedMessageSize: request.estimatedMessageSize,
  });
}

export function summarizeProviderResponse(payload: unknown): string | undefined {
  return truncateSummary(JSON.stringify(payload));
}

export function summarizeProviderError(payload: unknown): string | undefined {
  return truncateSummary(JSON.stringify(payload));
}

function normalizeEmailAddress(
  input: EmailAddressInput,
  field: string,
): EmailAddress {
  if (typeof input === "string") {
    return { address: normalizeEmail(input, field) };
  }

  const address = normalizeEmail(input.address, `${field}.address`);
  const name = normalizeOptionalString(input.name, `${field}.name`);
  return name ? { address, name } : { address };
}

function normalizeRecipients(
  input: string | string[] | undefined,
  field: string,
): string[] {
  if (input === undefined) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  const normalized = values.map((value, index) =>
    normalizeEmail(value, `${field}[${index}]`),
  );

  if (normalized.length === 0 && field === "to") {
    throw new Error("to must contain at least one recipient.");
  }

  return normalized;
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  const seen = new Set<string>();
  let totalBytes = 0;
  let whitelistedCount = 0;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    const value = ensureNonEmpty(rawValue, `headers.${rawName}`);
    const lowerName = name.toLowerCase();

    if (seen.has(lowerName)) {
      throw new Error(`Duplicate header '${name}' is not allowed.`);
    }
    seen.add(lowerName);

    const nameBytes = utf8ByteLength(name);
    const valueBytes = utf8ByteLength(value);
    if (nameBytes === 0 || nameBytes > MAX_CLOUDFLARE_HEADER_NAME_BYTES) {
      throw new Error(
        `Header '${name}' must be between 1 and ${MAX_CLOUDFLARE_HEADER_NAME_BYTES} bytes.`,
      );
    }
    if (valueBytes > MAX_CLOUDFLARE_HEADER_VALUE_BYTES) {
      throw new Error(
        `Header '${name}' exceeds the ${MAX_CLOUDFLARE_HEADER_VALUE_BYTES} byte value limit.`,
      );
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`Header '${name}' must not contain CR or LF characters.`);
    }

    if (API_FIELD_HEADERS.has(lowerName)) {
      throw new Error(
        `Header '${name}' must be set via the dedicated API field instead of headers.`,
      );
    }
    if (
      PLATFORM_CONTROLLED_HEADERS.has(lowerName) ||
      lowerName.startsWith("arc-")
    ) {
      throw new Error(`Header '${name}' is controlled by Cloudflare.`);
    }

    let canonicalName = WHITELISTED_HEADERS.get(lowerName);
    if (canonicalName) {
      if (!STANDARD_HEADER_PATTERN.test(name)) {
        throw new Error(`Header '${name}' contains invalid characters.`);
      }
      whitelistedCount += 1;
    } else {
      if (!X_HEADER_PATTERN.test(name)) {
        throw new Error(
          `Header '${name}' is not on Cloudflare's whitelist and is not a valid X- header.`,
        );
      }
      canonicalName = name;
    }

    totalBytes += nameBytes + 2 + valueBytes + 2;
    normalized[canonicalName] = value;
  }

  if (whitelistedCount > MAX_CLOUDFLARE_WHITELISTED_HEADERS) {
    throw new Error(
      `A maximum of ${MAX_CLOUDFLARE_WHITELISTED_HEADERS} whitelisted custom headers is allowed.`,
    );
  }
  if (totalBytes > MAX_CLOUDFLARE_HEADERS_BYTES) {
    throw new Error(
      `Custom headers exceed the ${formatBytes(MAX_CLOUDFLARE_HEADERS_BYTES)} Cloudflare limit.`,
    );
  }

  validateHeaderValues(normalized);
  return normalized;
}

function validateHeaderValues(headers: Record<string, string>) {
  const listUnsubscribe = headers["List-Unsubscribe"];
  if (listUnsubscribe) {
    const matches = Array.from(listUnsubscribe.matchAll(LIST_UNSUBSCRIBE_URI_PATTERN));
    if (matches.length === 0) {
      throw new Error(
        "List-Unsubscribe must contain at least one angle-bracketed https:// or mailto: URI.",
      );
    }
  }

  const listUnsubscribePost = headers["List-Unsubscribe-Post"];
  if (
    listUnsubscribePost &&
    listUnsubscribePost !== "List-Unsubscribe=One-Click"
  ) {
    throw new Error(
      "List-Unsubscribe-Post must be exactly 'List-Unsubscribe=One-Click'.",
    );
  }
  if (listUnsubscribePost && !listUnsubscribe?.includes("<https://")) {
    throw new Error(
      "List-Unsubscribe-Post requires List-Unsubscribe to include an HTTPS URI.",
    );
  }

  const precedence = headers.Precedence;
  if (
    precedence &&
    !["bulk", "list", "junk"].includes(precedence.toLowerCase())
  ) {
    throw new Error("Precedence must be one of bulk, list, or junk.");
  }

  const autoSubmitted = headers["Auto-Submitted"];
  if (
    autoSubmitted &&
    !["auto-generated", "auto-replied", "auto-notified"].includes(
      autoSubmitted.toLowerCase(),
    )
  ) {
    throw new Error(
      "Auto-Submitted must be one of auto-generated, auto-replied, or auto-notified.",
    );
  }

  const importance = headers.Importance;
  if (
    importance &&
    !["high", "normal", "low"].includes(importance.toLowerCase())
  ) {
    throw new Error("Importance must be one of high, normal, or low.");
  }

  const sensitivity = headers.Sensitivity;
  if (
    sensitivity &&
    !["personal", "private", "company-confidential"].includes(
      sensitivity.toLowerCase(),
    )
  ) {
    throw new Error(
      "Sensitivity must be one of personal, private, or company-confidential.",
    );
  }
}

function normalizeAttachments(
  attachments: ComponentSendEmailArgs["attachments"],
): NormalizedAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  return attachments.map((attachment, index) => {
    const filename = normalizeOptionalString(
      attachment.filename,
      `attachments[${index}].filename`,
    )!;
    const disposition =
      attachment.disposition ?? (attachment.contentId ? "inline" : "attachment");
    const contentId = normalizeOptionalString(
      attachment.contentId,
      `attachments[${index}].contentId`,
    );
    if (disposition === "inline" && !contentId) {
      throw new Error(
        `attachments[${index}] must include contentId when disposition is inline.`,
      );
    }
    if (disposition === "attachment" && contentId) {
      throw new Error(
        `attachments[${index}] must not include contentId unless disposition is inline.`,
      );
    }

    const content = normalizeBase64(attachment.content);
    const decodedBytes = estimateBase64DecodedBytes(content);
    const type = normalizeOptionalString(attachment.type, `attachments[${index}].type`);

    return {
      filename,
      content,
      type,
      disposition,
      contentId,
      encodedBytes: content.length,
      decodedBytes,
    };
  });
}

function normalizeStringRecord(
  input: Record<string, string> | undefined,
  field: string,
): Record<string, string> | undefined {
  if (!input || Object.keys(input).length === 0) {
    return undefined;
  }

  const normalizedEntries = Object.entries(input).map(([key, value]) => {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0) {
      throw new Error(`${field} keys must not be empty.`);
    }
    return [normalizedKey, value] as const;
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizeOptionalBody(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function normalizeOptionalString(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty when provided.`);
  }
  return normalized;
}

function ensureNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return value;
}

function normalizeEmail(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a valid email address.`);
  }
  return normalized;
}

function estimateMessageSize(input: {
  from: EmailAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments: NormalizedAttachment[];
}): number {
  let total = 1024;
  total += utf8ByteLength(input.from.address);
  total += utf8ByteLength(input.from.name ?? "");
  total += utf8ByteLength(input.subject);
  total += input.to.reduce((sum, value) => sum + utf8ByteLength(value), 0);
  total += input.cc.reduce((sum, value) => sum + utf8ByteLength(value), 0);
  total += input.bcc.reduce((sum, value) => sum + utf8ByteLength(value), 0);
  total += utf8ByteLength(input.replyTo?.address ?? "");
  total += utf8ByteLength(input.replyTo?.name ?? "");
  total += utf8ByteLength(input.html ?? "");
  total += utf8ByteLength(input.text ?? "");

  if (input.headers) {
    total += Object.entries(input.headers).reduce(
      (sum, [name, value]) => sum + utf8ByteLength(name) + 2 + utf8ByteLength(value) + 2,
      0,
    );
  }

  total += input.attachments.reduce(
    (sum, attachment) =>
      sum +
      attachment.encodedBytes +
      utf8ByteLength(attachment.filename) +
      utf8ByteLength(attachment.type ?? "") +
      utf8ByteLength(attachment.contentId ?? "") +
      256,
    0,
  );

  return total;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hashToUnitInterval(input: string): number {
  const hash = Number.parseInt(fnv1aHash(input), 16);
  return hash / 0xffffffff;
}

function truncateSummary(summary: string | undefined): string | undefined {
  if (!summary) {
    return undefined;
  }
  return summary.length > 8_000 ? `${summary.slice(0, 7_997)}...` : summary;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  }
  if (bytes >= 1024) {
    return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
  }
  return `${bytes} bytes`;
}
