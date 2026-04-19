import { v } from "convex/values";
import { query, internalQuery } from "./_generated/server.js";

export const getStatus = query({
  args: {
    emailId: v.id("emails"),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    return {
      id: email._id,
      state: email.state,
      acceptedAt: email.acceptedAt,
      lastAttemptAt: email.lastAttemptAt,
      nextRetryAt: email.nextRetryAt,
      attemptCount: email.attemptCount,
      result: email.result,
      error: email.error,
      metadata: email.metadata,
    };
  },
});

export const getDispatchStatus = internalQuery({
  args: {
    emailId: v.id("emails"),
  },
  handler: async (ctx, args) => {
    const email = await ctx.db.get(args.emailId);
    if (!email) {
      return null;
    }

    return {
      state: email.state,
      shouldDispatch:
        (email.state === "queued" || email.state === "retrying") &&
        !email.currentWorkId &&
        !email.dispatchReservationId,
    };
  },
});
