/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 後端沒有 /api 前綴：瀏覽器打 /api/xxx → proxy 到 127.0.0.1:8700/xxx
// build 產物落在 server/studio/web_dist/，讓 Studio 伺服器直接服務（pip wheel 也會打包進去）
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/studio/web_dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8700',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/ws': {
        target: 'ws://127.0.0.1:8700',
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['node_modules/**', 'e2e/**'], // e2e/ 是 Playwright，不給 vitest 撿
    environmentOptions: { jsdom: { url: 'http://localhost:5173' } },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // 44 個檔全開並行時 jsdom 會慢到讓 1 秒的 findBy 逾時而閃紅（單跑全綠）；限制並行、放寬單測上限
    testTimeout: 20000,
    hookTimeout: 20000,
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
})
