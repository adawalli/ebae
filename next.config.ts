import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pino's internal requires break when bundled; externalize so file-tracing
  // copies it into .next/standalone instead.
  serverExternalPackages: ["pino", "pino-pretty"],
};

export default nextConfig;
