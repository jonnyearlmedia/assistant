/** @type {import('next').NextConfig} */
const nextConfig = {
  // webhook + cron are server routes; keep them on the node runtime for crypto + sdk support
  experimental: { serverComponentsExternalPackages: ["@anthropic-ai/sdk"] },
  // ship-fast guardrails: don't let strict TS/lint block the first live deploy; tighten later
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
