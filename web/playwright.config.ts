import { defineConfig } from '@playwright/test'

// 端到端測試：對已跑在 8700 的正式版（含 web_dist、真 Hermes）逐頁走
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8700',
    viewport: { width: 1400, height: 900 },
    locale: 'zh-TW',
    screenshot: 'off',
    trace: 'off',
  },
})
