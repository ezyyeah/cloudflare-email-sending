import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSendFailure, sendWithCloudflare } from "./provider.js";
import type { RuntimeConfig } from "./shared.js";

describe("sendWithCloudflare", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the normalized Cloudflare payload and maps mixed recipient outcomes", async () => {
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

    const response = await sendWithCloudflare(baseConfig(), {
      from: {
        address: "sender@example.com",
        name: "Sender",
      },
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      replyTo: {
        address: "reply@example.com",
        name: "Reply",
      },
      subject: "Subject",
      text: "Body",
      html: "<p>Body</p>",
      headers: {
        "X-Trace-Id": "trace-123",
      },
      attachments: [
        {
          filename: "logo.png",
          content: "AQID",
          type: "image/png",
          disposition: "inline",
          contentId: "logo-cid",
        },
      ],
    });

    expect(response).toEqual({
      acceptance: {
        delivered: ["delivered@example.com"],
        queued: ["queued@example.com"],
        permanentBounces: ["bounced@example.com"],
      },
      httpStatus: 200,
      response: {
        success: true,
        result: {
          delivered: ["delivered@example.com"],
          queued: ["queued@example.com"],
          permanent_bounces: ["bounced@example.com"],
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/email/sending/send",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      from: {
        address: "sender@example.com",
        name: "Sender",
      },
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      reply_to: {
        address: "reply@example.com",
        name: "Reply",
      },
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
      headers: {
        "X-Trace-Id": "trace-123",
      },
      attachments: [
        {
          content: "AQID",
          filename: "logo.png",
          type: "image/png",
          disposition: "inline",
          content_id: "logo-cid",
        },
      ],
    });
  });

  it.each([
    [429, true],
    [503, true],
    [400, false],
  ])(
    "classifies HTTP %i failures with retryable=%s",
    async (status, retryable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(status, {
            success: false,
            errors: [
              {
                code: status,
                message: `HTTP ${status}`,
              },
            ],
          }),
        ),
      );

      const error = await expectFailure(() =>
        sendWithCloudflare(baseConfig(), {
          from: { address: "sender@example.com" },
          to: ["recipient@example.com"],
          cc: [],
          bcc: [],
          subject: "Subject",
          text: "Body",
          attachments: [],
        }),
      );

      expect(error.details).toMatchObject({
        httpStatus: status,
        code: status,
        message: `HTTP ${status}`,
        retryable,
      });
    },
  );

  it.each([
    [
      "non-JSON 2xx bodies",
      new Response("<html>ok</html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      }),
    ],
    [
      "JSON 2xx bodies without Cloudflare recipient arrays",
      jsonResponse(200, {
        success: true,
        result: {
          delivered: ["recipient@example.com"],
        },
      }),
    ],
  ])("rejects %s", async (_, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await expectFailure(() =>
      sendWithCloudflare(baseConfig(), {
        from: { address: "sender@example.com" },
        to: ["recipient@example.com"],
        cc: [],
        bcc: [],
        subject: "Subject",
        text: "Body",
        attachments: [],
      }),
    );

    expect(error.details).toMatchObject({
      httpStatus: 200,
      code: "unexpected_success_response",
      message: "Cloudflare Email Service returned an unexpected 2xx response body.",
      retryable: false,
    });
  });
});

async function expectFailure<T>(fn: () => Promise<T>) {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareSendFailure);
    return error as CloudflareSendFailure;
  }
  throw new Error("Expected CloudflareSendFailure");
}

function baseConfig(): RuntimeConfig {
  return {
    accountId: "account-1",
    apiToken: "token-1",
    apiBaseUrl: "https://api.cloudflare.com/client/v4",
    initialBackoffMs: 1_000,
    maxAttempts: 3,
    maxBackoffMs: 5_000,
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
