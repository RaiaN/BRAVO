/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev overlay's floating badge sits on top of the rail's bottom rows — this shell
  // is judged on its own chrome.
  devIndicators: false,
  // The desktop package (§9: "packageable app") loads the export over file://, where
  // absolute /_next/… paths do not resolve. Set BRAVO_DESKTOP=1 at build time to emit
  // relative asset paths; the dev server and a hosted build are unaffected.
  ...(process.env.BRAVO_DESKTOP === '1' ? { assetPrefix: '.', trailingSlash: true } : {}),
};

module.exports = nextConfig;
