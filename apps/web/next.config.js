/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required so Next.js compiles our workspace packages (TS path-mapped, not built).
  transpilePackages: ['@pullvault/db', '@pullvault/domain', '@pullvault/shared'],
  // Allow card images from pokemontcg.io's CDN.
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'images.pokemontcg.io' }],
  },
  experimental: {
    // postgres-js is CJS internally; tell Next not to bundle node_modules into RSC.
    serverComponentsExternalPackages: ['postgres', 'bcryptjs'],
  },
};

module.exports = nextConfig;
