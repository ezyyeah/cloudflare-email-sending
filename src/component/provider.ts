import type {
  EmailAddress,
  EmailError,
  ProviderAcceptance,
  RuntimeConfig,
} from "./shared.js";

type ProviderAttachment = {
  filename: string;
  content: string;
  type?: string;
  disposition: "attachment" | "inline";
  contentId?: string;
};

type ProviderSendRequest = {
  from: EmailAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments: ProviderAttachment[];
};

type CloudflareErrorEnvelope = {
  success?: boolean;
  errors?: Array<{
    code?: number | string;
    message?: string;
  }>;
  messages?: Array<{
    code?: number | string;
    message?: string;
  }>;
  result?: {
    delivered?: unknown;
    queued?: unknown;
    permanent_bounces?: unknown;
  } | null;
};

type CloudflareSuccessEnvelope = {
  success: true;
  result: {
    delivered: string[];
    queued: string[];
    permanent_bounces: string[];
  };
};

export type CloudflareSendSuccess = {
  acceptance: ProviderAcceptance;
  httpStatus: number;
  response: unknown;
};

export class CloudflareSendFailure extends Error {
  constructor(
    message: string,
    readonly details: EmailError,
    readonly response?: unknown,
  ) {
    super(message);
    this.name = "CloudflareSendFailure";
  }
}

export async function sendWithCloudflare(
  config: RuntimeConfig,
  request: ProviderSendRequest,
): Promise<CloudflareSendSuccess> {
  const endpoint = `${config.apiBaseUrl.replace(/\/$/, "")}/accounts/${config.accountId}/email/sending/send`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(request)),
    });
  } catch (error) {
    throw new CloudflareSendFailure(
      error instanceof Error ? error.message : "Cloudflare request failed.",
      {
        message:
          error instanceof Error ? error.message : "Cloudflare request failed.",
        retryable: true,
      },
    );
  }

  const payload = await parseResponse(response);
  if (response.ok) {
    const envelope = asSuccessEnvelope(payload);
    if (!envelope) {
      throw new CloudflareSendFailure(
        "Cloudflare Email Service returned an unexpected 2xx response body.",
        {
          httpStatus: response.status,
          code: "unexpected_success_response",
          message:
            "Cloudflare Email Service returned an unexpected 2xx response body.",
          retryable: false,
        },
        payload,
      );
    }

    return {
      acceptance: {
        delivered: envelope.result.delivered,
        queued: envelope.result.queued,
        permanentBounces: envelope.result.permanent_bounces,
      },
      httpStatus: response.status,
      response: payload,
    };
  }

  const { details, message } = classifyProviderFailure(response.status, payload);
  throw new CloudflareSendFailure(message, details, payload);
}

function buildRequestBody(request: ProviderSendRequest) {
  return {
    from: formatAddress(request.from),
    to: oneOrMany(request.to),
    cc: optionalOneOrMany(request.cc),
    bcc: optionalOneOrMany(request.bcc),
    reply_to: request.replyTo ? formatAddress(request.replyTo) : undefined,
    subject: request.subject,
    html: request.html,
    text: request.text,
    headers: request.headers,
    attachments:
      request.attachments.length > 0
        ? request.attachments.map((attachment) =>
            attachment.disposition === "inline"
              ? {
                  content: attachment.content,
                  filename: attachment.filename,
                  type: attachment.type,
                  disposition: "inline" as const,
                  content_id: attachment.contentId,
                }
              : {
                  content: attachment.content,
                  filename: attachment.filename,
                  type: attachment.type,
                  disposition: "attachment" as const,
                },
          )
        : undefined,
  };
}

function classifyProviderFailure(
  httpStatus: number,
  payload: unknown,
): { details: EmailError; message: string } {
  const envelope = payload as CloudflareErrorEnvelope | undefined;
  const firstError = envelope?.errors?.[0];
  const code = firstError?.code;
  const message =
    firstError?.message ??
    `Cloudflare Email Service request failed with HTTP ${httpStatus}.`;
  const retryable = isRetryableProviderFailure(httpStatus, code);

  return {
    details: {
      httpStatus,
      code,
      message,
      retryable,
    },
    message,
  };
}

function isRetryableProviderFailure(
  httpStatus: number,
  code: number | string | undefined,
): boolean {
  if (httpStatus === 429 || httpStatus >= 500) {
    return true;
  }

  if (code === 10004 || code === "email.sending.error.throttled") {
    return true;
  }

  return false;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function formatAddress(address: EmailAddress): string | EmailAddress {
  return address.name ? address : address.address;
}

function asSuccessEnvelope(payload: unknown): CloudflareSuccessEnvelope | null {
  if (!isRecord(payload) || payload.success !== true) {
    return null;
  }

  const { result } = payload;
  if (!isRecord(result)) {
    return null;
  }

  if (
    !isStringArray(result.delivered) ||
    !isStringArray(result.queued) ||
    !isStringArray(result.permanent_bounces)
  ) {
    return null;
  }

  return {
    success: true,
    result: {
      delivered: result.delivered,
      queued: result.queued,
      permanent_bounces: result.permanent_bounces,
    },
  };
}

function oneOrMany(values: string[]): string | string[] {
  return values.length === 1 ? values[0] : values;
}

function optionalOneOrMany(values: string[]): string | string[] | undefined {
  return values.length === 0 ? undefined : oneOrMany(values);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
