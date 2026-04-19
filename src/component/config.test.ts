import { afterEach, describe, expect, it } from "vitest";
import {
  resolveOperationalConfig,
  resolveRuntimeConfig,
} from "./config.js";

const originalAccountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID;
const originalApiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN;
const originalApiBaseUrl = process.env.CLOUDFLARE_EMAIL_API_BASE_URL;

describe("runtime config resolution", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("reads provider credentials from env and merges operational overrides", () => {
    process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID = "env-account";
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = "env-token";
    process.env.CLOUDFLARE_EMAIL_API_BASE_URL = "https://env.example.test";

    expect(
      resolveRuntimeConfig({
        initialBackoffMs: 5_000,
        maxAttempts: 7,
      }),
    ).toEqual({
      accountId: "env-account",
      apiToken: "env-token",
      apiBaseUrl: "https://env.example.test",
      initialBackoffMs: 5_000,
      maxAttempts: 7,
      maxBackoffMs: 30 * 60 * 1000,
    });
  });

  it("throws honest guidance when env-backed credentials are missing", () => {
    delete process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;

    expect(() => resolveRuntimeConfig()).toThrow(
      "Set CLOUDFLARE_EMAIL_ACCOUNT_ID in the app environment or pass accountId to the CloudflareEmail client.",
    );

    process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID = "env-account";

    expect(() => resolveRuntimeConfig()).toThrow(
      "Set CLOUDFLARE_EMAIL_API_TOKEN in the app environment or pass apiToken to the CloudflareEmail client.",
    );
  });

  it("keeps public operational config free of provider credentials", () => {
    process.env.CLOUDFLARE_EMAIL_API_BASE_URL = "https://env.example.test";

    expect(resolveOperationalConfig()).toEqual({
      apiBaseUrl: "https://env.example.test",
      initialBackoffMs: 30_000,
      maxAttempts: 5,
      maxBackoffMs: 30 * 60 * 1000,
    });
  });
});

function restoreEnv() {
  if (originalAccountId === undefined) {
    delete process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID;
  } else {
    process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID = originalAccountId;
  }

  if (originalApiToken === undefined) {
    delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
  } else {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = originalApiToken;
  }

  if (originalApiBaseUrl === undefined) {
    delete process.env.CLOUDFLARE_EMAIL_API_BASE_URL;
  } else {
    process.env.CLOUDFLARE_EMAIL_API_BASE_URL = originalApiBaseUrl;
  }
}
