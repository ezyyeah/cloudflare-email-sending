import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { finalizeAcceptedAttempt } from "./actions.js";
import type { RuntimeConfig } from "./shared.js";
import schema from "./schema.js";
import { SEND_WORKPOOL_MOUNT_NAME } from "./shared.js";

const modules = import.meta.glob("./**/*.ts");

describe("durable send actions", () => {
  const originalAccountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T14:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnv(
      "CLOUDFLARE_EMAIL_ACCOUNT_ID",
      originalAccountId,
    );
    restoreEnv(
      "CLOUDFLARE_EMAIL_API_TOKEN",
      originalApiToken,
    );
    vi.stubGlobal("fetch", originalFetch);
  });

  it("uses credentials persisted from the app-side runtime config during background processing", async () => {
    const t = setupTest();
    const emailId = await persistEmail(t, {
      idempotencyKey: "email-env-token",
      config: makeConfig({
        accountId: "passed-account",
        apiToken: "passed-token",
        initialBackoffMs: 30_000,
        maxAttempts: 5,
        maxBackoffMs: 30 * 60 * 1000,
      }),
      text: "hello",
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            delivered: ["recipient@example.com"],
            queued: [],
            permanent_bounces: [],
          },
        }),
        {
          status: 202,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await t.action(internal.actions.processEmail, { emailId });

    expect(outcome).toBe("processed");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/accounts/passed-account/email/sending/send");
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer passed-token");
  });

  it("marks accepted sends as needing reconciliation when local success bookkeeping throws", async () => {
    const runMutation = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated write failure"))
      .mockResolvedValueOnce("needs_reconciliation");

    const outcome = await finalizeAcceptedAttempt(
      { runMutation } as never,
      {
        emailId: "email_123" as never,
        attemptId: "attempt_123" as never,
        response: {
          httpStatus: 202,
          acceptance: {
            delivered: ["recipient@example.com"],
            queued: [],
            permanentBounces: [],
          },
          response: {
            success: true,
          },
        },
      },
    );

    expect(outcome).toBe("needs_reconciliation");
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
      emailId: "email_123",
      attemptId: "attempt_123",
      httpStatus: 202,
    });
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      emailId: "email_123",
      attemptId: "attempt_123",
      httpStatus: 202,
      acceptance: {
        delivered: ["recipient@example.com"],
        queued: [],
        permanentBounces: [],
      },
    });
    expect(runMutation.mock.calls[1]?.[1]?.errorMessage).toContain(
      "Cloudflare accepted the email",
    );
    expect(runMutation.mock.calls[1]?.[1]?.errorMessage).toContain(
      "simulated write failure",
    );
  });
});

function setupTest() {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, SEND_WORKPOOL_MOUNT_NAME);
  return t;
}

function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    accountId: "default-account",
    apiToken: "default-token",
    apiBaseUrl: "https://api.cloudflare.com/client/v4",
    initialBackoffMs: 30_000,
    maxAttempts: 5,
    maxBackoffMs: 30 * 60 * 1000,
    ...overrides,
  };
}

async function persistEmail(
  t: TestConvex<typeof schema>,
  args: {
    idempotencyKey: string;
    config: RuntimeConfig;
    text: string;
  },
) {
  const storageId = await t.run(async (ctx) => {
    return await ctx.storage.store(
      new Blob([args.text], { type: "text/plain;charset=utf-8" }),
    );
  });

  const result = await t.mutation(internal.mutations.persistEmail, {
    request: {
      from: { address: "sender@example.com", name: "Sender" },
      to: ["recipient@example.com"],
      subject: "Subject",
      idempotencyKey: args.idempotencyKey,
      payloadFingerprint: `fingerprint:${args.idempotencyKey}`,
      estimatedMessageSize: 512,
    },
    content: {
      text: {
        storageId,
        bytes: new TextEncoder().encode(args.text).byteLength,
        mimeType: "text/plain",
      },
      attachments: [],
    },
    config: args.config,
  });

  return result.emailId;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
