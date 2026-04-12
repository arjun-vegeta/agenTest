import type { NextConfig } from 'next';

// Static export for GitHub Pages.
// basePath is set when deploying to a project page (https://<user>.github.io/<repo>/).
// For a custom domain or root deployment, set BASE_PATH="" in the workflow env.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // Required so Next bakes basePath into <Link> hrefs at build time.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
