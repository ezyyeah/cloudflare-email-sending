import { CloudflareEmail } from "@ezyyeah/cloudflare-email-sending";
import { components } from "./_generated/api.js";

export const email = new CloudflareEmail(components.cloudflareEmail);
