import { CloudflareEmail } from "@ezyyeah/cloudflare-email-sending";
import { components } from "./_generated/api.js";

new CloudflareEmail(components.cloudflareEmail, {
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
  apiToken: "runtime-token",
});

new CloudflareEmail(components.cloudflareEmail, {
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
  accountId: "runtime-account",
});
