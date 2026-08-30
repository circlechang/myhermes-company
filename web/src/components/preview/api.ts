// 預覽 API：檔案路徑走 GET /preview，純文字走 POST /preview/inline，原檔位元組走 /preview/raw
import { useQuery } from '@tanstack/react-query'
import { API_BASE, getToken, request } from '../../api/client'
import type { PreviewData, PreviewKind, PreviewSource } from './types'

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, v)
  return p.toString()
}

export const previewApi = {
  file: (path: string, kind: string = 'auto') => request<PreviewData>(`/preview?${qs({ path, kind })}`),
  inline: (text: string, kind = 'auto', title = '', language = '') =>
    request<PreviewData>('/preview/inline', { method: 'POST', body: JSON.stringify({ text, kind, title, language }) }),
  /** `<img>`／`<object>` 帶不了 Authorization header，所以 token 走 query（後端同時接受兩種）。
   *  路徑尾巴補上檔名，瀏覽器的 PDF 檢視器標題與「另存新檔」預設名才會對。 */
  rawUrl: (path: string, download = false) => {
    const name = encodeURIComponent(path.split('/').pop() || 'file')
    return `${API_BASE}/preview/raw/${name}?${qs({ path, download: download ? 'true' : undefined, token: getToken() ?? undefined })}`
  },
}

/** 副檔名 → kind，給 `url` 來源在沒有 format 時猜。 */
export function guessKind(nameOrUrl: string): PreviewKind {
  const clean = nameOrUrl.split(/[?#]/)[0]
  const ext = (clean.split('.').pop() ?? '').toLowerCase()
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown'
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff'].includes(ext)) return 'image'
  if (['csv', 'tsv'].includes(ext)) return 'csv'
  if (ext === 'docx') return 'docx'
  if (ext === 'pptx') return 'pptx'
  if (['xlsx', 'xlsm'].includes(ext)) return 'xlsx'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (ext === '') return 'code'
  return 'code'
}

export function sourceKey(source: PreviewSource): unknown[] {
  if (source.kind === 'path') return ['preview', 'path', source.path, source.format ?? 'auto']
  if (source.kind === 'inline') return ['preview', 'inline', source.title ?? '', source.format ?? 'auto', source.text.length, source.text.slice(0, 256)]
  return ['preview', 'url', source.url, source.format ?? 'auto']
}

async function fetchUrlSource(source: Extract<PreviewSource, { kind: 'url' }>): Promise<PreviewData> {
  const kind = (source.format && source.format !== 'auto' ? source.format : guessKind(source.title || source.url)) as PreviewKind
  const base: PreviewData = {
    kind,
    title: source.title || decodeURIComponent(source.url.split('/').pop() ?? 'file'),
    path: source.url,
    size: source.size ?? 0,
    mtime: source.mtime ?? 0,
    mime: '',
    meta: {},
    warnings: [],
    url: source.url,
    download_url: source.downloadUrl ?? source.url,
  }
  if (kind === 'image' || kind === 'pdf') return base
  const token = getToken()
  const res = await fetch(source.url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const text = await res.text()
  return { ...base, text, size: source.size ?? text.length, meta: { language: 'text', lines: text.split('\n').length } }
}

export function usePreviewSource(source: PreviewSource | null, enabled = true) {
  return useQuery<PreviewData>({
    queryKey: source ? sourceKey(source) : ['preview', 'none'],
    enabled: enabled && !!source,
    retry: false,
    queryFn: async () => {
      if (!source) throw new Error('no source')
      if (source.kind === 'path') return previewApi.file(source.path, source.format ?? 'auto')
      if (source.kind === 'inline')
        return previewApi.inline(source.text, source.format ?? 'auto', source.title ?? '', source.language ?? '')
      return fetchUrlSource(source)
    },
  })
}

/** 這個來源可下載嗎？（inline 內容用 blob 下載，不打後端） */
export function downloadUrlFor(source: PreviewSource, data?: PreviewData): string | null {
  if (source.kind === 'path') return previewApi.rawUrl(source.path, true)
  if (source.kind === 'url') return source.downloadUrl ?? source.url
  return data?.text ? `data:text/plain;charset=utf-8,${encodeURIComponent(data.text)}` : null
}

/** 用來在新分頁開啟／`<img src>`／`<embed src>` 的原檔 URL。 */
export function rawUrlFor(source: PreviewSource): string | null {
  if (source.kind === 'path') return previewApi.rawUrl(source.path)
  if (source.kind === 'url') return source.url
  return null
}
