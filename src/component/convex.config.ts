import workpool from "@convex-dev/workpool/convex.config.js";
import { defineComponent } from "convex/server";
import {
  DEFAULT_CLOUDFLARE_EMAIL_MOUNT_NAME,
  SEND_WORKPOOL_MOUNT_NAME,
} from "./shared.js";

const component = defineComponent(DEFAULT_CLOUDFLARE_EMAIL_MOUNT_NAME);
component.use(workpool, { name: SEND_WORKPOOL_MOUNT_NAME });

export default component;
