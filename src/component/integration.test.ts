import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { RuntimeConfig } from "./shared.js";
import schema from "./schema.js";
import { SEND_WORKPOOL_MOUNT_NAME } from "./shared.js";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("durable send pipeline", () => {
  const originalAccountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T14:00:00.000Z"));
    process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID = "account-a";
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = "token-a";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreEnv(
      "CLOUDFLARE_EMAIL_ACCOUNT_ID",
      originalAccountId,
    );
    restoreEnv(
      "CLOUDFLARE_EMAIL_API_TOKEN",
      originalApiToken,
    );
  });

  it("persists mixed recipient outcomes from Cloudflare acceptance responses", async () => {
    const t = setupTest();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        result: {
          delivered: ["delivered@example.com"],
          queued: ["queued@example.com"],
          permanent_bounces: ["bounced@example.com"],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const emailId = (await t.action(api.actions.send, {
      request: baseRequest({
        to: [
          "delivered@example.com",
          "queued@example.com",
          "bounced@example.com",
        ],
      }),
      config: baseConfig(),
    })) as Id<"emails">;

    await flushScheduledFunctions(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectStatus(t, emailId, {
      state: "processed",
      attemptCount: 1,
      result: {
        delivered: ["delivered@example.com"],
        queued: ["queued@example.com"],
        permanentBounces: ["bounced@example.com"],
      },
      error: undefined,
    });
  });

  it.each([429, 503])(
    "retries retryable Cloudflare failures for HTTP %i before succeeding",
    async (status) => {
      const t = setupTest();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(status, {
            success: false,
            errors: [
              {
                code: status,
                message: `HTTP ${status}`,
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            success: true,
            result: {
              delivered: ["recipient@example.com"],
              queued: [],
              permanent_bounces: [],
            },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const emailId = (await t.action(api.actions.send, {
        request: baseRequest({
          idempotencyKey: `retry-${status}`,
        }),
        config: baseConfig({
          initialBackoffMs: 1_000,
          maxBackoffMs: 1_000,
        }),
      })) as Id<"emails">;

      await flushScheduledFunctions(t);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expectStatus(t, emailId, {
        state: "processed",
        attemptCount: 2,
        result: {
          delivered: ["recipient@example.com"],
          queued: [],
          permanentBounces: [],
        },
        error: undefined,
      });

      await t.run(async (ctx) => {
        const attempts = await ctx.db
          .query("attempts")
          .withIndex("by_emailId", (query) => query.eq("emailId", emailId))
          .collect();
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({
          httpStatus: status,
          retryable: true,
          errorMessage: `HTTP ${status}`,
        });
        expect(attempts[1]).toMatchObject({
          httpStatus: 200,
          retryable: false,
        });
      });
    },
  );

  it("fails without retrying for non-retryable 4xx responses", async () => {
    const t = setupTest();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        success: false,
        errors: [
          {
            code: 400,
            message: "invalid schema",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const emailId = (await t.action(api.actions.send, {
      request: baseRequest({
        idempotencyKey: "invalid-400",
      }),
      config: baseConfig(),
    })) as Id<"emails">;

    await flushScheduledFunctions(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectStatus(t, emailId, {
      state: "failed",
      attemptCount: 1,
      result: undefined,
      error: {
        httpStatus: 400,
        code: 400,
        message: "invalid schema",
        retryable: false,
      },
    });
  });

  it("fails malformed 2xx provider responses instead of marking the email processed", async () => {
    const t = setupTest();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>proxy response</html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const emailId = (await t.action(api.actions.send, {
      request: baseRequest({
        idempotencyKey: "unexpected-2xx",
      }),
      config: baseConfig(),
    })) as Id<"emails">;

    await flushScheduledFunctions(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectStatus(t, emailId, {
      state: "failed",
      attemptCount: 1,
      result: undefined,
      error: {
        httpStatus: 200,
        code: "unexpected_success_response",
        message: "Cloudflare Email Service returned an unexpected 2xx response body.",
        retryable: false,
      },
    });
  });

  it("deduplicates repeated enqueue requests by idempotency key", async () => {
    const t = setupTest();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        result: {
          delivered: ["recipient@example.com"],
          queued: [],
          permanent_bounces: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = baseRequest({
      idempotencyKey: "idempotent-send",
    });

    const [firstEmailId, secondEmailId] = (await Promise.all([
      t.action(api.actions.send, {
        request,
        config: baseConfig(),
      }),
      t.action(api.actions.send, {
        request,
        config: baseConfig(),
      }),
    ])) as [Id<"emails">, Id<"emails">];

    expect(firstEmailId).toBe(secondEmailId);

    await flushScheduledFunctions(t);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expectStatus(t, firstEmailId, {
      state: "processed",
      attemptCount: 1,
      result: {
        delivered: ["recipient@example.com"],
        queued: [],
        permanentBounces: [],
      },
      error: undefined,
    });
  });

  it("cancels queued emails before provider work starts", async () => {
    const t = setupTest();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const emailId = (await t.action(api.actions.send, {
      request: baseRequest({
        idempotencyKey: "cancelled-email",
      }),
      config: baseConfig(),
    })) as Id<"emails">;

    const cancelState = await t.mutation(api.mutations.cancel, {
      emailId,
    });

    expect(cancelState).toBe("cancelled");

    await flushScheduledFunctions(t);

    expect(fetchMock).not.toHaveBeenCalled();
    await expectStatus(t, emailId, {
      state: "cancelled",
      attemptCount: 0,
      result: undefined,
      error: undefined,
    });
  });
});

function setupTest() {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, SEND_WORKPOOL_MOUNT_NAME);
  return t;
}

async function flushScheduledFunctions(
  t: ReturnType<typeof setupTest>,
) {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

async function expectStatus(
  t: ReturnType<typeof setupTest>,
  emailId: Id<"emails">,
  expected: {
    state: string;
    attemptCount: number;
    result: unknown;
    error: unknown;
  },
) {
  const status = await t.query(api.queries.getStatus, {
    emailId: emailId as never,
  });

  expect(status?.id).toBe(emailId);
  expect(status?.state).toBe(expected.state);
  expect(status?.attemptCount).toBe(expected.attemptCount);
  expect(status?.result).toEqual(expected.result);
  expect(status?.error).toEqual(expected.error);

  if (expected.state === "processed") {
    expect(status?.acceptedAt).toBeTypeOf("number");
    expect(status?.lastAttemptAt).toBeTypeOf("number");
  }

  if (expected.state === "failed" || expected.state === "cancelled") {
    expect(status?.nextRetryAt).toBeUndefined();
  }
}

function baseConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    accountId: "account-a",
    apiToken: "token-a",
    apiBaseUrl: "https://api.cloudflare.com/client/v4",
    initialBackoffMs: 1_000,
    maxAttempts: 3,
    maxBackoffMs: 5_000,
    ...overrides,
  };
}

function baseRequest(
  overrides: Partial<{
    from: string;
    to: string | string[];
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }> = {},
) {
  return {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Subject",
    text: "Body",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
