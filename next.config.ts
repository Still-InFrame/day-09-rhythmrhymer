import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray ~/package-lock.json makes Turbopack pick the wrong workspace root.
  turbopack: { root: __dirname },
};

export default nextConfig;
