import { v } from "convex/values";

import type { EmailId } from "@ezyyeah/cloudflare-email-sending";

import { action } from "./_generated/server.js";
import { email } from "./email.js";

export const sendExample = action({
  args: {
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await email.send(ctx, {
      from: {
        address: args.fromAddress,
        name: args.fromName,
      },
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });

    return { id };
  },
});

export const getStatusExample = action({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    return await email.getStatus(ctx, args.id as EmailId);
  },
});

export const cancelExample = action({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    return await email.cancel(ctx, args.id as EmailId);
  },
});
