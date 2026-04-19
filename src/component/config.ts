import type { OperationalConfig, RuntimeConfig } from "./shared.js";

export const DEFAULT_CLOUDFLARE_API_BASE_URL =
  "https://api.cloudflare.com/client/v4";
export const DEFAULT_INITIAL_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000;

export type OperationalConfigOptions = Partial<OperationalConfig>;
export type RuntimeConfigOptions = Partial<RuntimeConfig>;

export function getDefaultOperationalConfig(): OperationalConfig {
  return {
    apiBaseUrl: process.env.CLOUDFLARE_EMAIL_API_BASE_URL ?? DEFAULT_CLOUDFLARE_API_BASE_URL,
    initialBackoffMs: DEFAULT_INITIAL_BACKOFF_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
  };
}

export function resolveOperationalConfig(
  overrides?: OperationalConfigOptions,
): OperationalConfig {
  const defaults = getDefaultOperationalConfig();
  return {
    apiBaseUrl: overrides?.apiBaseUrl ?? defaults.apiBaseUrl,
    initialBackoffMs:
      overrides?.initialBackoffMs ?? defaults.initialBackoffMs,
    maxAttempts: overrides?.maxAttempts ?? defaults.maxAttempts,
    maxBackoffMs: overrides?.maxBackoffMs ?? defaults.maxBackoffMs,
  };
}

export function resolveRuntimeConfig(
  overrides?: RuntimeConfigOptions,
): RuntimeConfig {
  const config: RuntimeConfig = {
    ...resolveOperationalConfig(overrides),
    accountId:
      overrides?.accountId ?? process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID ?? "",
    apiToken:
      overrides?.apiToken ?? process.env.CLOUDFLARE_EMAIL_API_TOKEN ?? "",
  };

  if (config.accountId === "") {
    throw new Error(
      "Cloudflare Email account ID is required. Set CLOUDFLARE_EMAIL_ACCOUNT_ID in the app environment or pass accountId to the CloudflareEmail client.",
    );
  }

  if (config.apiToken === "") {
    throw new Error(
      "Cloudflare Email API token is required. Set CLOUDFLARE_EMAIL_API_TOKEN in the app environment or pass apiToken to the CloudflareEmail client.",
    );
  }

  return config;
}
