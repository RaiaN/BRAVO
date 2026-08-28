/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev overlay's floating badge sits on top of the rail's bottom rows — this shell
  // is judged on its own chrome.
  devIndicators: false,
};

module.exports = nextConfig;
