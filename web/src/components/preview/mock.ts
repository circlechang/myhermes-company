// Mock 模式（VITE_MOCK=1 與 vitest）用的 /preview 回應，形狀對齊後端 studio/modules/preview
import type { PreviewData, PreviewKind } from './types'
import { guessKind } from './api'

const MD = `# 預覽標題

一段前言。

## 第一節

- 一
- 二
- [x] 已完成

## 第二節

| 欄位 | 值 |
| --- | ---: |
| a | 1 |
| b | 2 |
`

export function previewMock(path: string, method: string, body: Record<string, unknown>, u: URL): PreviewData | null {
  if (path === '/preview/inline' && method === 'POST') {
    const text = String(body.text ?? '')
    const kind = (body.kind && body.kind !== 'auto' ? body.kind : 'markdown') as PreviewKind
    return {
      kind,
      title: String(body.title || 'output'),
      path: '',
      size: text.length,
      mtime: 0,
      mime: 'text/markdown',
      meta: { inline: true, language: String(body.language || 'text'), lines: text.split('\n').length },
      warnings: [],
      text,
    }
  }
  if (path !== '/preview') return null
  const p = u.searchParams.get('path') ?? ''
  const name = p.split('/').pop() ?? p
  const kind = guessKind(name)
  const base: PreviewData = {
    kind,
    title: name,
    path: p,
    size: 1234,
    mtime: 1756500000,
    mime: '',
    meta: {},
    warnings: [],
    url: `/api/preview/raw?path=${encodeURIComponent(p)}`,
    download_url: `/api/preview/raw?path=${encodeURIComponent(p)}&download=true`,
  }
  switch (kind) {
    case 'markdown':
      return { ...base, text: MD }
    case 'csv':
      return { ...base, rows: [['a', 'b'], ['1', '2'], ['3', '4']], meta: { numeric_cols: [0, 1], total_rows: 3, total_cols: 2 } }
    case 'html':
      return { ...base, text: '<h1>hi</h1>' }
    case 'docx':
      return {
        ...base,
        html: '<h1 id="h-0">Doc</h1><p>內文 <strong>粗體</strong></p><h2 id="h-1">小節</h2><table><thead><tr><th>c1</th></tr></thead><tbody><tr><td>v1</td></tr></tbody></table>',
        meta: { headings: [{ level: 1, text: 'Doc', id: 'h-0' }, { level: 2, text: '小節', id: 'h-1' }] },
      }
    case 'xlsx':
      return {
        ...base,
        sheets: [
          { name: 'S1', rows: [['h', 'v'], ['1', '2']], merges: [], freeze: { rows: 1, cols: 0 }, numeric_cols: [1], total_rows: 2, total_cols: 2, truncated: false, hidden: false },
          { name: 'S2', rows: [['x'], ['9']], merges: [], freeze: { rows: 0, cols: 0 }, numeric_cols: [0], total_rows: 2, total_cols: 1, truncated: false, hidden: false },
        ],
        meta: { sheet_names: ['S1', 'S2'] },
      }
    case 'pptx':
      return {
        ...base,
        pages: [
          { index: 1, title: '第 1 頁', body: ['重點 A'], notes: '備註 1', images: [], tables: [] },
          { index: 2, title: '第 2 頁', body: ['重點 B'], notes: '', images: [], tables: [] },
        ],
        meta: { slides: 2 },
      }
    case 'pdf':
      return { ...base, pages: [{ index: 1, text: 'page one text' }, { index: 2, text: 'page two text' }], meta: { pages: 2 } }
    case 'image':
      return { ...base, meta: { width: 64, height: 48, format: 'PNG', mode: 'RGB' } }
    default:
      return { ...base, kind: 'code', text: 'print(1)\n', meta: { language: 'python', lines: 2, encoding: 'utf-8' } }
  }
}
