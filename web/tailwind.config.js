/** @type {import('tailwindcss').Config} */
export default {
  // 主題模組：跟隨系統（預設）或以 <html data-theme="dark|light"> 強制
  darkMode: ['variant', [
    '@media (prefers-color-scheme: dark) { &:not(:is([data-theme="light"], [data-theme="light"] *)) }',
    '&:is([data-theme="dark"], [data-theme="dark"] *)',
  ]],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
