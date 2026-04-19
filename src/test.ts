/// <reference types="vite/client" />
import workpoolTest from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
import {
  DEFAULT_CLOUDFLARE_EMAIL_MOUNT_NAME,
  SEND_WORKPOOL_MOUNT_NAME,
} from "./component/shared.js";

const modules = import.meta.glob([
  "./component/**/*.ts",
  "!./component/**/*.test.ts",
]);

export function register<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
  t: TestConvex<Schema>,
  name: string = DEFAULT_CLOUDFLARE_EMAIL_MOUNT_NAME,
) {
  workpoolTest.register(t, SEND_WORKPOOL_MOUNT_NAME);
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
