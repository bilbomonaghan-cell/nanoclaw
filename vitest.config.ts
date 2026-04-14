import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    env: {
      // Prevent Node's undici EnvHttpProxyAgent from routing test HTTP requests
      // through the container proxy — credential-proxy tests need direct loopback access.
      NODE_USE_ENV_PROXY: '',
      HTTPS_PROXY: '',
      https_proxy: '',
      HTTP_PROXY: '',
      http_proxy: '',
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
  },
});
