import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray lockfile above the workspace confuses root inference; pin it.
  outputFileTracingRoot: path.resolve("./"),
};

export default nextConfig;
