import { convexTest } from "convex-test";
import cloudflareEmailTest from "@ezyyeah/cloudflare-email-sending/test";

const t = convexTest();
cloudflareEmailTest.register(t);

void t;
