/** @type {import('next').NextConfig} */
const nextConfig = {
  // webhook + cron are server routes; keep them on the node runtime for crypto + sdk support
  experimental: { serverComponentsExternalPackages: ["@anthropic-ai/sdk"] },
};

export default nextConfig;
