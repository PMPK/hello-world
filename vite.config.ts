import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';
import { GAME_INFO } from './src/config/gameInfo.ts';

/**
 * Base path resolution:
 *  - VITE_BASE env var wins (e.g. VITE_BASE=/hello-world/ npm run build)
 *  - on GitHub Actions we derive it from the repository name, so a project
 *    Pages site is served from https://<owner>.github.io/<repo>/
 *  - locally we use '/'
 */
function resolveBase(): string {
  if (process.env.VITE_BASE) return process.env.VITE_BASE;
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (process.env.GITHUB_ACTIONS && repo) {
    return repo.toLowerCase().endsWith('.github.io') ? '/' : `/${repo}/`;
  }
  return '/';
}

/**
 * VITE_TARGET=artifact builds a service-worker-free bundle with relative paths
 * (packaged into a single self-contained HTML file by scripts/build-artifact.mjs).
 */
const artifact = process.env.VITE_TARGET === 'artifact';

export default defineConfig({
  base: artifact ? './' : resolveBase(),
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    sourcemap: false,
    outDir: artifact ? 'dist-artifact' : 'dist',
  },
  resolve: {
    alias: artifact ? { 'virtual:pwa-register': fileURLToPath(new URL('./src/pwa/stub.ts', import.meta.url)) } : {},
  },
  plugins: [
    {
      name: 'game-title-html',
      transformIndexHtml(html: string) {
        return html.replace(/%GAME_TITLE%/g, GAME_INFO.title).replace(/%GAME_DESCRIPTION%/g, GAME_INFO.description);
      },
    },
    !artifact &&
      VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png', '.nojekyll'],
      manifest: {
        id: './',
        name: GAME_INFO.title,
        short_name: GAME_INFO.shortTitle,
        description: GAME_INFO.description,
        theme_color: GAME_INFO.themeColor,
        background_color: GAME_INFO.backgroundColor,
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        start_url: './',
        scope: './',
        categories: ['games', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
