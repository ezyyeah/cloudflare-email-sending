import cloudflareEmail from "@ezyyeah/cloudflare-email-sending/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(cloudflareEmail);

export default app;
