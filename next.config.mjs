/** @type {import('next').NextConfig} */
const nextConfig = {
  // Linux/UAE container builds retain standalone output. Windows uses normal
  // next start output because standalone tracing needs OS symlink privileges.
  ...(process.platform === 'win32' ? {} : { output: 'standalone' }),
  poweredByHeader: false,
};
export default nextConfig;
