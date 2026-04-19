import { describe, expect, it } from "vitest";
import {
  MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES,
  MAX_CLOUDFLARE_RECIPIENTS,
  type ComponentSendEmailArgs,
} from "./shared.js";
import { normalizeSendRequest } from "./validation.js";

describe("normalizeSendRequest", () => {
  it("normalizes addresses, headers, and attachments into a stable payload", () => {
    const result = normalizeSendRequest({
      from: {
        address: " Sender@Example.com ",
        name: " Sender ",
      },
      to: ["  First@Example.com ", "Second@Example.com"],
      cc: " Third@Example.com ",
      replyTo: " Reply@Example.com ",
      subject: " Subject ",
      text: "Hello",
      headers: {
        " list-unsubscribe ": "<https://example.com/unsub>",
        "X-Trace-Id": "trace-123",
      },
      attachments: [
        {
          filename: " receipt.txt ",
          content: Buffer.from("hello world").toString("base64"),
        },
        {
          filename: "logo.png",
          content: Buffer.from([1, 2, 3]).toString("base64"),
          disposition: "inline",
          contentId: "logo-cid",
        },
      ],
      metadata: {
        " campaign ": "welcome",
      },
      idempotencyKey: " send:1 ",
    });

    expect(result).toMatchObject({
      from: {
        address: "sender@example.com",
        name: "Sender",
      },
      to: ["first@example.com", "second@example.com"],
      cc: ["third@example.com"],
      bcc: [],
      replyTo: {
        address: "reply@example.com",
      },
      subject: "Subject",
      text: "Hello",
      headers: {
        "List-Unsubscribe": "<https://example.com/unsub>",
        "X-Trace-Id": "trace-123",
      },
      metadata: {
        campaign: "welcome",
      },
      idempotencyKey: "send:1",
    });
    expect(result.attachments).toEqual([
      expect.objectContaining({
        filename: "receipt.txt",
        disposition: "attachment",
        decodedBytes: 11,
      }),
      expect.objectContaining({
        filename: "logo.png",
        disposition: "inline",
        contentId: "logo-cid",
        decodedBytes: 3,
      }),
    ]);
    expect(result.payloadFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.estimatedMessageSize).toBeGreaterThan(0);
  });

  it("rejects forbidden custom headers before enqueue", () => {
    expect(() =>
      normalizeSendRequest({
        ...baseRequest(),
        headers: {
          Subject: "nope",
        },
      }),
    ).toThrow("dedicated API field");
  });

  it("rejects recipient counts above the Cloudflare limit", () => {
    expect(() =>
      normalizeSendRequest({
        ...baseRequest(),
        to: Array.from({ length: MAX_CLOUDFLARE_RECIPIENTS + 1 }, (_, index) =>
          `user-${index}@example.com`,
        ),
      }),
    ).toThrow(`${MAX_CLOUDFLARE_RECIPIENTS} recipients`);
  });

  it("rejects payloads that exceed the estimated message size limit", () => {
    expect(() =>
      normalizeSendRequest({
        ...baseRequest(),
        text: "x".repeat(MAX_CLOUDFLARE_MESSAGE_SIZE_BYTES),
      }),
    ).toThrow("Estimated message size exceeds");
  });
});

function baseRequest(
  overrides: Partial<ComponentSendEmailArgs> = {},
): ComponentSendEmailArgs {
  return {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Subject",
    text: "Body",
    ...overrides,
  };
}
