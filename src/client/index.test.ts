import { describe, expect, it, vi } from "vitest";
import {
  CloudflareEmail,
  type SendEmailArgs,
} from "./index.js";

describe("CloudflareEmail client wrapper", () => {
  it("resolves storage-backed attachments in action contexts", async () => {
    const runAction = vi.fn().mockResolvedValue("email-1");
    const storageGet = vi
      .fn()
      .mockResolvedValue(new Blob(["hello world"], { type: "text/plain" }));
    const client = new CloudflareEmail(componentRef(), {
      apiBaseUrl: "https://email.example.test",
      initialBackoffMs: 5_000,
      maxAttempts: 7,
      maxBackoffMs: 60_000,
    });

    const inlineAttachments: SendEmailArgs["attachments"] = [
      {
        filename: "inline.txt",
        content: Buffer.from("inline body").toString("base64"),
        type: "text/plain",
      },
      {
        filename: "stored.txt",
        storageId: "storage-1",
      },
    ];

    const emailId = await client.send(
      {
        runAction,
        storage: {
          get: storageGet,
        } as never,
      },
      {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Subject",
        text: "Body",
        attachments: inlineAttachments,
      },
    );

    expect(emailId).toBe("email-1");
    expect(storageGet).toHaveBeenCalledTimes(1);
    expect(storageGet).toHaveBeenCalledWith("storage-1");
    expect(runAction).toHaveBeenCalledWith("sendAction", {
      config: {
        apiBaseUrl: "https://email.example.test",
        initialBackoffMs: 5_000,
        maxAttempts: 7,
        maxBackoffMs: 60_000,
      },
      request: {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Subject",
        text: "Body",
        attachments: [
          {
            filename: "inline.txt",
            content: Buffer.from("inline body").toString("base64"),
            type: "text/plain",
          },
          {
            filename: "stored.txt",
            content: Buffer.from("hello world").toString("base64"),
            type: "text/plain",
          },
        ],
      },
    });
    expect(inlineAttachments).toEqual([
      {
        filename: "inline.txt",
        content: Buffer.from("inline body").toString("base64"),
        type: "text/plain",
      },
      {
        filename: "stored.txt",
        storageId: "storage-1",
      },
    ]);
  });

  it("rejects unreadable storage-backed attachments before calling the component", async () => {
    const client = new CloudflareEmail(componentRef());
    const runAction = vi.fn();

    await expect(
      client.send(
        {
          runAction,
          storage: {
            get: vi.fn().mockResolvedValue(null),
          } as never,
        },
        {
          from: "sender@example.com",
          to: "recipient@example.com",
          subject: "Subject",
          text: "Body",
          attachments: [
            {
              filename: "missing.txt",
              storageId: "missing-storage-id",
            },
          ],
        },
      ),
    ).rejects.toThrow("could not be read");

    expect(runAction).not.toHaveBeenCalled();
  });
});

function componentRef() {
  return {
    actions: {
      send: "sendAction",
    },
    mutations: {
      cancel: "cancelMutation",
    },
    queries: {
      getStatus: "getStatusQuery",
    },
  } as never;
}
