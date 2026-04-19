import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { RuntimeConfig } from "./shared.js";
import schema from "./schema.js";
import { SEND_WORKPOOL_MOUNT_NAME } from "./shared.js";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("durable send mutations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T14:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries with the full runtime config persisted on the email", async () => {
    const t = setupTest();
    const primaryConfig = makeConfig({
      accountId: "account-a",
      apiToken: "token-a",
      initialBackoffMs: 30_000,
      maxAttempts: 5,
      maxBackoffMs: 30 * 60 * 1000,
    });
    const overwrittenConfig = makeConfig({
      accountId: "account-b",
      apiToken: "token-b",
      initialBackoffMs: 1_000,
      maxAttempts: 1,
      maxBackoffMs: 1_000,
    });

    const emailId = await persistEmail(t, {
      idempotencyKey: "email-a",
      config: primaryConfig,
      text: "first",
    });

    await persistEmail(t, {
      idempotencyKey: "email-b",
      config: overwrittenConfig,
      text: "second",
    });

    const preparation = await t.mutation(internal.mutations.prepareAttempt, {
      emailId,
    });
    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") {
      throw new Error("expected ready preparation");
    }

    expect(preparation.config).toEqual({
      accountId: primaryConfig.accountId,
      apiToken: primaryConfig.apiToken,
      apiBaseUrl: primaryConfig.apiBaseUrl,
      initialBackoffMs: primaryConfig.initialBackoffMs,
      maxAttempts: primaryConfig.maxAttempts,
      maxBackoffMs: primaryConfig.maxBackoffMs,
    });

    await t.run(async (ctx) => {
      const email = (await ctx.db.get(emailId)) as Doc<"emails"> | null;
      expect(email?.runtimeConfig).toEqual(preparation.config);
    });

    const completion = await t.mutation(
      internal.mutations.completeAttemptFailure,
      {
        emailId,
        attemptId: preparation.attemptId,
        finishedAt: Date.now(),
        error: {
          message: "rate limited",
          httpStatus: 429,
          retryable: true,
        },
        responseSummary: "429",
      },
    );

    expect(completion).toBe("retrying");
    const status = await t.query(api.queries.getStatus, { emailId });
    expect(status?.state).toBe("retrying");
    expect(status?.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it("stores accepted-but-unreconciled sends in an explicit terminal state", async () => {
    const t = setupTest();
    const emailId = await persistEmail(t, {
      idempotencyKey: "email-needs-reconciliation",
      config: makeConfig({
        initialBackoffMs: 30_000,
        maxAttempts: 5,
        maxBackoffMs: 30 * 60 * 1000,
      }),
      text: "body",
    });

    const preparation = await t.mutation(internal.mutations.prepareAttempt, {
      emailId,
    });
    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") {
      throw new Error("expected ready preparation");
    }

    const completion = await t.mutation(
      internal.mutations.completeAttemptNeedsReconciliation,
      {
        emailId,
        attemptId: preparation.attemptId,
        finishedAt: Date.now(),
        httpStatus: 202,
        acceptance: {
          delivered: ["recipient@example.com"],
          queued: [],
          permanentBounces: [],
        },
        responseSummary: "{\"success\":true}",
        errorMessage:
          "Cloudflare accepted the email, but local bookkeeping failed afterwards. Reconciliation is required before retrying or resending. Cause: simulated write failure",
      },
    );

    expect(completion).toBe("needs_reconciliation");

    const status = await t.query(api.queries.getStatus, { emailId });
    expect(status).toMatchObject({
      state: "needs_reconciliation",
      acceptedAt: Date.now(),
      attemptCount: 1,
      result: {
        delivered: ["recipient@example.com"],
        queued: [],
        permanentBounces: [],
      },
      error: {
        retryable: false,
      },
    });
    expect(status?.error?.message).toContain("Cloudflare accepted the email");
  });

  it("reconciles interrupted sending attempts instead of leaving them stranded", async () => {
    const t = setupTest();
    const emailId = await persistEmail(t, {
      idempotencyKey: "email-stalled-send",
      config: makeConfig({
        initialBackoffMs: 30_000,
        maxAttempts: 5,
        maxBackoffMs: 30 * 60 * 1000,
      }),
      text: "body",
    });

    const reservationId = "reservation-stalled";
    await t.mutation(internal.mutations.reserveDispatch, {
      emailId,
      reservationId,
    });
    await t.mutation(internal.mutations.activateDispatchedWork, {
      emailId,
      reservationId,
      workId: "work-stalled",
    });

    const preparation = await t.mutation(internal.mutations.prepareAttempt, {
      emailId,
    });
    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") {
      throw new Error("expected ready preparation");
    }

    await t.run(async (ctx) => {
      const email = (await ctx.db.get(emailId)) as Doc<"emails"> | null;
      expect(email?.state).toBe("sending");
      expect(email?.currentWorkId).toBe("work-stalled");
    });

    const reconciliation = await t.mutation(
      internal.mutations.reconcileStalledAttempt,
      {
        emailId,
        attemptId: preparation.attemptId,
        startedAt: preparation.startedAt,
        workId: "work-stalled",
      },
    );

    expect(reconciliation).toBe("needs_reconciliation");

    const completion = await t.mutation(
      internal.mutations.completeAttemptFailure,
      {
        emailId,
        attemptId: preparation.attemptId,
        finishedAt: Date.now(),
        error: {
          message: "network timeout",
          httpStatus: 503,
          retryable: true,
        },
        responseSummary: "503",
      },
    );

    expect(completion).toBe("needs_reconciliation");

    const status = await t.query(api.queries.getStatus, { emailId });
    expect(status).toMatchObject({
      state: "needs_reconciliation",
      attemptCount: 1,
      error: {
        retryable: false,
      },
    });
    expect(status?.error?.message).toContain("requires reconciliation");

    await t.run(async (ctx) => {
      const attempt = (await ctx.db.get(
        preparation.attemptId,
      )) as Doc<"attempts"> | null;
      expect(attempt?.finishedAt).toBeTypeOf("number");
      expect(attempt?.retryable).toBe(true);
      expect(attempt?.errorMessage).toBe("network timeout");
    });
    expect(status?.nextRetryAt).toBeUndefined();
  });

  it("allows only one outstanding dispatch reservation per email", async () => {
    const t = setupTest();
    const emailId = await persistEmail(t, {
      idempotencyKey: "email-c",
      config: makeConfig({
        initialBackoffMs: 30_000,
        maxAttempts: 5,
        maxBackoffMs: 30 * 60 * 1000,
      }),
      text: "body",
    });

    const first = await t.mutation(internal.mutations.reserveDispatch, {
      emailId,
      reservationId: "reservation-1",
    });
    const second = await t.mutation(internal.mutations.reserveDispatch, {
      emailId,
      reservationId: "reservation-2",
    });

    expect(first).toEqual({
      kind: "reserved",
      state: "queued",
    });
    expect(second).toEqual({
      kind: "skipped",
      state: "queued",
    });

    await t.run(async (ctx) => {
      const email = (await ctx.db.get(emailId)) as Doc<"emails"> | null;
      expect(email?.dispatchReservationId).toBe("reservation-1");
      expect(email?.currentWorkId).toBeUndefined();
    });
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
