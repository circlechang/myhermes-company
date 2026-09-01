/** @type {import('tailwindcss').Config} */
export default {
  // 主題模組：跟隨系統（預設）或以 <html data-theme="dark|light"> 強制
  darkMode: ['variant', [
    '@media (prefers-color-scheme: dark) { &:not(:is([data-theme="light"], [data-theme="light"] *)) }',
    '&:is([data-theme="dark"], [data-theme="dark"] *)',
  ]],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 字級整體比 Tailwind 預設放大一級，行高一併加大。
      // 理由：這個介面拿 text-xs 當內文用（500+ 處），照原尺寸在 CJK 下太小。
      // 改這裡等於一次調整全站，元件不用逐個改 class。
      fontSize: {
        '2xs': ['0.75rem', '1.125rem'],   // 12px — 真的需要極小字時才用
        xs: ['0.8125rem', '1.25rem'],     // 13px（原 12px）：次要文字、標籤
        sm: ['0.9375rem', '1.5rem'],      // 15px（原 14px）：介面內文
        base: ['1.0625rem', '1.6875rem'], // 17px（原 16px）
        lg: ['1.1875rem', '1.75rem'],     // 19px（原 18px）
        xl: ['1.375rem', '1.875rem'],     // 22px（原 20px）
      },
    },
  },
  plugins: [],
}
