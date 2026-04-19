import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(exampleDir, ".."),
};

export default nextConfig;
