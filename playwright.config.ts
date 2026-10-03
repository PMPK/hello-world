import { defineConfig } from '@playwright/test';

/**
 * Browser smoke tests. Uses the locally installed Chromium (SwiftShader WebGL).
 * Run: npm run test:e2e   (builds and serves the production bundle)
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [
    {
      name: 'phone-landscape-touch',
      use: { viewport: { width: 915, height: 412 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
    },
    {
      name: 'desktop-mouse',
      use: { viewport: { width: 1280, height: 720 } },
    },
  ],
});
