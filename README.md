# @ezyyeah/cloudflare-email-sending

[![Convex Component](https://www.convex.dev/components/badge/ezyyeah/cloudflare-email-sending)](https://www.convex.dev/components/ezyyeah/cloudflare-email-sending)

Durable transactional email sending for Convex through Cloudflare Email Service.

This package is queue-first: `send()` stores the request in the component, schedules background work, and returns a component-generated email id for later status lookup.

Cloudflare Email Service is currently in beta. Features, limits, and API behavior may still change before general availability.

## Install

```bash
npm install @ezyyeah/cloudflare-email-sending
```

Mount the component in your Convex app config:

```ts
import cloudflareEmail from "@ezyyeah/cloudflare-email-sending/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(cloudflareEmail);

export default app;
```

## Cloudflare Setup

Before sending email, make sure your Cloudflare account is ready:

1. Add your sending domain to Cloudflare and use Cloudflare DNS for it.
2. Open `Email Sending` in the Cloudflare dashboard.
3. Onboard the domain you want to send from.
4. Wait for the DNS records Cloudflare adds for SPF, DKIM, DMARC, and bounce handling to propagate.

Cloudflare may initially limit new accounts to sending only to verified recipient addresses.

## Convex Environment Variables

Set these in your Convex app deployment:

- `CLOUDFLARE_EMAIL_ACCOUNT_ID`
- `CLOUDFLARE_EMAIL_API_TOKEN`

Optional:

- `CLOUDFLARE_EMAIL_API_BASE_URL`

Example:

```bash
npx convex env set CLOUDFLARE_EMAIL_ACCOUNT_ID your-account-id
npx convex env set CLOUDFLARE_EMAIL_API_TOKEN your-api-token
```

These env vars belong in the app deployment, not inside the component. The wrapper reads them in the app runtime and forwards the resolved provider config into the isolated component.

## How To Get The Cloudflare Values

### `CLOUDFLARE_EMAIL_ACCOUNT_ID`

You can copy the account ID from either of these places in Cloudflare:

1. `Account Home`
2. Open the menu next to the account
3. Click `Copy account ID`

Or:

1. `Workers & Pages`
2. Find the `Account details` section
3. Copy the `Account ID`

### `CLOUDFLARE_EMAIL_API_TOKEN`

Create a Cloudflare API token for the same account:

1. Open `My Profile > API Tokens` for a user token, or `Manage Account > API Tokens` for an account token.
2. Click `Create Token`.
3. Create a custom token.
4. Restrict it to the Cloudflare account you onboarded for Email Sending.
5. Give it permission to send emails.
6. Create the token and copy the secret immediately.

Cloudflare only shows the token secret once, so store it securely.

## Client Wrapper

```ts
import { CloudflareEmail } from "@ezyyeah/cloudflare-email-sending";
import { components } from "./_generated/api";

export const email = new CloudflareEmail(components.cloudflareEmail, {
  accountId: process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_EMAIL_API_TOKEN,
  initialBackoffMs: 5_000,
  maxAttempts: 7,
  maxBackoffMs: 60_000,
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
});
```

Supported constructor options:

- `accountId`
- `apiToken`
- `apiBaseUrl`
- `initialBackoffMs`
- `maxAttempts`
- `maxBackoffMs`

Defaults:

- `apiBaseUrl`: `https://api.cloudflare.com/client/v4`
- `initialBackoffMs`: `30_000`
- `maxAttempts`: `5`
- `maxBackoffMs`: `1_800_000`

If you omit `accountId` and `apiToken` in the constructor, the wrapper reads `CLOUDFLARE_EMAIL_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN` from the app runtime at send time.

## Usage

`send()` expects an action context with `runAction`. If you use storage-backed attachments, the same context must also expose `storage.get()` because the wrapper resolves the file before calling the component.

```ts
import { action } from "./_generated/server";
import { email } from "./email";

export const sendWelcomeEmail = action({
  args: {},
  handler: async (ctx) => {
    return await email.send(ctx, {
      from: { address: "welcome@example.com", name: "Acme" },
      to: "user@example.com",
      subject: "Welcome",
      html: "<h1>Welcome</h1>",
      text: "Welcome",
      headers: {
        "X-Campaign-ID": "welcome-2026-04",
      },
      idempotencyKey: "user_123:welcome",
    });
  },
});
```

Attachment inputs support either inline base64 content or app-storage resolution:

```ts
await email.send(ctx, {
  from: "ops@example.com",
  to: "user@example.com",
  subject: "Receipt",
  text: "Attached.",
  attachments: [
    {
      filename: "receipt.pdf",
      storageId: receiptStorageId,
      type: "application/pdf",
    },
    {
      filename: "terms.txt",
      content: Buffer.from("hello").toString("base64"),
      type: "text/plain",
    },
  ],
});
```

Status lookup and cancellation use the wrapper against Convex query and mutation contexts:

```ts
const status = await email.getStatus(ctx, emailId);
const state = await email.cancel(ctx, emailId);
```

Public wrapper methods:

- `send(ctx, args): Promise<EmailId>`
- `getStatus(ctx, emailId): Promise<EmailStatus<EmailId> | null>`
- `cancel(ctx, emailId): Promise<EmailState | null>`

## Send Contract

`send()` validates the request before enqueueing:

- At least one of `html` or `text` is required.
- A maximum of 50 total recipients is allowed across `to`, `cc`, and `bcc`.
- Estimated message size must stay within Cloudflare's 25 MiB limit.
- Custom headers are validated locally and platform-controlled headers are rejected.
- Empty attachment filenames and unreadable `storageId` attachments are rejected before dispatch.

If you reuse an `idempotencyKey` with the same normalized payload, the component returns the existing `EmailId`. Reusing the same key with a different payload throws `IdempotencyConflictError`.

## Status Semantics

`getStatus()` returns one of these states:

- `queued`
- `sending`
- `retrying`
- `processed`
- `needs_reconciliation`
- `failed`
- `cancelled`

`processed` means Cloudflare accepted the send request and returned immediate recipient outcomes. It does not mean final inbox delivery was confirmed.

`needs_reconciliation` means Cloudflare accepted the request, but local bookkeeping failed afterwards. Treat that state as terminal until you inspect the stored record and decide whether to resend manually.

## Operational Notes

- Provider credentials are resolved in the app runtime, then persisted with the queued email so background work can run inside the isolated component.
- Retries use exponential backoff with deterministic jitter for retryable network, `429`, and `5xx` failures.
- Status is acceptance-level only. Cloudflare webhook or downstream lifecycle tracking is not implemented here yet.
- This package is intended for transactional email flows. It does not position Cloudflare Email Service as a bulk or marketing transport.

## Current Scope

This package focuses on outbound sending.

It does not currently include:

- inbound routing or receiving
- webhook-driven delivery lifecycle updates
- analytics or suppression tooling
- component-owned uploads
- remote URL attachment fetching
- multi-account credential routing

## Package Exports

- `@ezyyeah/cloudflare-email-sending`
- `@ezyyeah/cloudflare-email-sending/convex.config.js`
- `@ezyyeah/cloudflare-email-sending/test`

## Local Example

The repository includes a runnable React + Next.js example app in [`example`](./example).

From the repository root:

```bash
pnpm install
pnpm dev
```

That starts:

- `convex dev` for the example backend in `example/convex`
- a React + Next.js app on [http://127.0.0.1:3000](http://127.0.0.1:3000)

Optional provider setup for actual delivery:

```bash
cd example
npx convex env set CLOUDFLARE_EMAIL_ACCOUNT_ID your-account-id
npx convex env set CLOUDFLARE_EMAIL_API_TOKEN your-api-token
```

Without those env vars in the app runtime, the example still runs, but send attempts will fail before provider dispatch.

## References

- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
- [Cloudflare send emails guide](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Cloudflare REST API docs](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
- [Find account and zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)
- [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
