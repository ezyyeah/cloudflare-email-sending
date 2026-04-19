import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api.js";

export const sendWorkpool = new Workpool(components.sendWorkpool, {
  retryActionsByDefault: false,
});
