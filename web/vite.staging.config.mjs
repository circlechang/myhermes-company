// 暫存站用：前端走 dev server（5190），API 代理到 MHC_STAGING（預設 8710）。不寫 web_dist，不影響 8700。
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
const T = process.env.MHC_STAGING ?? 'http://127.0.0.1:8710'
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
    proxy: {
      '/api': { target: T, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: T.replace(/^http/, 'ws'), ws: true },
    },
  },
})
