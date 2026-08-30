// 共用檔案預覽元件：各 kind 的渲染、表格排序／搜尋、inline 來源、錯誤與大檔狀態
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import '../../i18n'
import { setFetchImpl, setToken } from '../../api/client'
import { FilePreview } from './FilePreview'
import type { PreviewData } from './types'

const base = {
  title: 'x',
  path: 'workspace/x',
  size: 1234,
  mtime: 1756500000,
  mime: '',
  meta: {},
  warnings: [] as string[],
  url: '/api/preview/raw?path=workspace%2Fx',
  download_url: '/api/preview/raw?path=workspace%2Fx&download=true',
}

let reply: (path: string, init: RequestInit) => Response
const seen: { path: string; body?: unknown }[] = []

beforeEach(() => {
  seen.length = 0
  setToken('t')
  setFetchImpl((async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    seen.push({ path: url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return reply(url, init)
  }) as typeof fetch)
})

const ok = (data: PreviewData) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const serve = (data: PreviewData) => {
  reply = () => ok(data)
}
const view = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const path = { kind: 'path', path: 'workspace/x' } as const

describe('FilePreview 各格式', () => {
  it('markdown：渲染內容、產生目錄、工具列顯示大小與時間', async () => {
    serve({ ...base, title: 'r.md', kind: 'markdown', text: '# 標題\n\n## 一節\n\n內文\n\n## 二節\n\n- a\n- b\n' })
    view(<FilePreview source={path} />)
    const md = await screen.findByTestId('markdown-preview')
    expect(md).toHaveTextContent('內文')
    expect(within(md).getByRole('heading', { name: '標題' })).toBeInTheDocument()
    const toc = await screen.findByTestId('preview-toc')
    expect(within(toc).getByRole('button', { name: '一節' })).toBeInTheDocument()
    expect(within(toc).getByRole('button', { name: '二節' })).toBeInTheDocument()
    expect(screen.getByTestId('preview-title')).toHaveTextContent('r.md')
    expect(screen.getByTestId('preview-meta')).toHaveTextContent('1.2 KB')
    expect(screen.getByTestId('preview-download')).toHaveAttribute('href', expect.stringContaining('download=true'))
  })

  it('csv：可搜尋、可排序、數字欄右對齊', async () => {
    serve({
      ...base,
      title: 'd.csv',
      kind: 'csv',
      rows: [
        ['品項', '數量'],
        ['提袋', '800'],
        ['循環箱', '1200'],
        ['棧板', '90'],
      ],
      meta: { numeric_cols: [1], total_rows: 4, total_cols: 2 },
    })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    const table = await screen.findByTestId('table-preview')
    const rowsOf = () => within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(rowsOf()).toEqual(['提袋', '循環箱', '棧板'])
    // 依「數量」排序（數字比較，不是字串比較）
    await user.click(within(table).getByRole('button', { name: /數量/ }))
    expect(rowsOf()).toEqual(['棧板', '提袋', '循環箱'])
    await user.click(within(table).getByRole('button', { name: /數量/ }))
    expect(rowsOf()).toEqual(['循環箱', '提袋', '棧板'])
    // 搜尋
    await user.type(screen.getByTestId('table-search'), '循環')
    expect(rowsOf()).toEqual(['循環箱'])
    expect(screen.getByTestId('table-count')).toHaveTextContent('1 / 3')
    await user.clear(screen.getByTestId('table-search'))
    await user.type(screen.getByTestId('table-search'), 'zzz')
    expect(within(table).getByText('沒有符合的列')).toBeInTheDocument()
  })

  it('xlsx：多工作表可切換，截斷會提示', async () => {
    serve({
      ...base,
      title: 'r.xlsx',
      kind: 'xlsx',
      sheets: [
        { name: '營收', rows: [['月', '額'], ['一月', '100']], merges: [], freeze: { rows: 1, cols: 1 }, numeric_cols: [1], total_rows: 500, total_cols: 3, truncated: true, hidden: false },
        { name: '備註', rows: [['說明'], ['第二張']], merges: [], freeze: { rows: 0, cols: 0 }, numeric_cols: [], total_rows: 2, total_cols: 1, truncated: false, hidden: false },
      ],
      warnings: ['表格已截斷'],
    })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    expect(await screen.findByTestId('xlsx-preview')).toHaveTextContent('一月')
    expect(screen.getByTestId('preview-warnings')).toHaveTextContent('表格已截斷')
    await user.click(screen.getByTestId('sheet-tab-備註'))
    expect(screen.getByTestId('table-preview')).toHaveTextContent('第二張')
  })

  it('pptx：縮圖列切換投影片，顯示備註', async () => {
    serve({
      ...base,
      title: 'd.pptx',
      kind: 'pptx',
      pages: [
        { index: 1, title: '第一頁', body: ['重點 A'], notes: '備註一', images: [], tables: [] },
        { index: 2, title: '第二頁', body: ['重點 B'], notes: '備註二', images: [], tables: [] },
      ],
      meta: { slides: 2 },
    })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    expect(await screen.findByTestId('slide-body')).toHaveTextContent('重點 A')
    expect(screen.getByTestId('slide-notes')).toHaveTextContent('備註一')
    await user.click(screen.getByTestId('slide-thumb-2'))
    expect(screen.getByTestId('slide-body')).toHaveTextContent('重點 B')
  })

  it('pdf：頁碼跳轉並顯示該頁文字', async () => {
    serve({ ...base, title: 'a.pdf', kind: 'pdf', pages: [{ index: 1, text: 'page one' }, { index: 2, text: 'page two' }], meta: { pages: 2 } })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    const pdf = await screen.findByTestId('pdf-preview')
    expect(within(pdf).getByTestId('pdf-object')).toHaveAttribute('data', expect.stringContaining('#page=1'))
    await user.click(within(pdf).getByTestId('pdf-toggle-text'))
    expect(screen.getByTestId('pdf-text')).toHaveTextContent('page one')
    await user.click(within(pdf).getByLabelText('下一頁'))
    expect(screen.getByTestId('pdf-text')).toHaveTextContent('page two')
    expect(within(pdf).getByTestId('pdf-object')).toHaveAttribute('data', expect.stringContaining('#page=2'))
  })

  it('image：顯示尺寸與縮放控制', async () => {
    serve({ ...base, title: 'p.png', kind: 'image', meta: { width: 64, height: 48, format: 'PNG', exif: { Make: 'Apple' } } })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    const img = await screen.findByTestId('image-preview')
    expect(img).toHaveTextContent('64×48')
    expect(screen.getByTestId('image-exif')).toHaveTextContent('Apple')
    await user.click(within(img).getByLabelText('放大'))
    expect(screen.getByTestId('image-zoom')).toHaveTextContent('125%')
  })

  it('code：行號、語言標籤、換行切換', async () => {
    serve({ ...base, title: 'b.py', kind: 'code', text: 'a = 1\nb = 2\nc = 3\n', meta: { language: 'python', lines: 4 } })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    expect(await screen.findByTestId('code-lang')).toHaveTextContent('python')
    expect(screen.getByTestId('code-gutter')).toHaveTextContent('123')
    await user.click(screen.getByTestId('preview-wrap'))
    expect(screen.queryByTestId('code-gutter')).not.toBeInTheDocument()
  })

  it('html：預設沙箱 iframe，可切原始碼', async () => {
    serve({ ...base, title: 'p.html', kind: 'html', text: '<h1>hi</h1>' })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    const frame = (await screen.findByTestId('html-preview')) as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>hi</h1>')
    await user.click(screen.getByRole('button', { name: '原始碼' }))
    expect(await screen.findByTestId('code-preview')).toHaveTextContent('<h1>hi</h1>')
  })

  it('docx：後端 HTML 直接渲染並產生目錄', async () => {
    serve({
      ...base,
      title: 'r.docx',
      kind: 'docx',
      html: '<h1 id="h-0">報告</h1><p>內文 <strong>粗</strong></p><h2 id="h-1">明細</h2><table><thead><tr><th>c</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table>',
      meta: { headings: [{ level: 1, text: '報告', id: 'h-0' }, { level: 2, text: '明細', id: 'h-1' }] },
    })
    view(<FilePreview source={path} />)
    const doc = await screen.findByTestId('docx-preview')
    expect(within(doc).getByRole('heading', { name: '報告' })).toBeInTheDocument()
    expect(within(doc).getByText('粗').tagName).toBe('STRONG')
    expect(within(doc).getByRole('cell', { name: 'v' })).toBeInTheDocument()
    expect(within(await screen.findByTestId('preview-toc')).getByRole('button', { name: '明細' })).toBeInTheDocument()
  })
})

describe('FilePreview 狀態與來源', () => {
  it('載入中顯示骨架，不是白畫面', async () => {
    let release: (r: Response) => void = () => {}
    reply = () => new Response(JSON.stringify({ ...base, kind: 'markdown', text: 'x' }))
    setFetchImpl((() => new Promise<Response>((res) => { release = res })) as unknown as typeof fetch)
    view(<FilePreview source={path} />)
    expect(await screen.findByTestId('preview-loading')).toBeInTheDocument()
    release(new Response(JSON.stringify({ ...base, kind: 'markdown', text: '好了' }), { status: 200 }))
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('好了')
  })

  it('後端錯誤顯示錯誤框與重試', async () => {
    reply = () => new Response(JSON.stringify({ error: { code: 'not_found', message: '找不到檔案' } }), { status: 404 })
    view(<FilePreview source={path} />)
    expect(await screen.findByText('找不到檔案')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument()
  })

  it('大檔只給下載，不嘗試渲染', async () => {
    serve({ ...base, title: 'huge.md', kind: 'markdown', size: 12 * 1024 * 1024, too_large: true, warnings: ['檔案 12 MB 超過 10MB'] })
    view(<FilePreview source={path} />)
    const box = await screen.findByTestId('preview-binary')
    expect(box).toHaveTextContent('huge.md')
    expect(within(box).getByRole('link', { name: '下載' })).toHaveAttribute('href', expect.stringContaining('download=true'))
    expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()
  })

  it('不支援的格式給清楚說明', async () => {
    serve({ ...base, title: 'a.bin', kind: 'binary' })
    view(<FilePreview source={path} />)
    expect(await screen.findByTestId('preview-binary')).toHaveTextContent('沒有內建預覽')
  })

  it('inline 來源：打 /preview/inline，關閉鈕與額外動作可用', async () => {
    reply = (url) => {
      expect(url).toContain('/preview/inline')
      return ok({ ...base, path: '', kind: 'markdown', title: 'node-a', text: '# 節點輸出', meta: { inline: true } })
    }
    const onClose = vi.fn()
    const user = userEvent.setup()
    view(
      <FilePreview
        source={{ kind: 'inline', text: '# 節點輸出', title: 'node-a' }}
        onClose={onClose}
        actions={<button type="button">附回聊天</button>}
      />,
    )
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('節點輸出')
    expect(seen.at(-1)?.body).toMatchObject({ text: '# 節點輸出', title: 'node-a' })
    // inline 沒有原檔可以「新分頁開啟」
    expect(screen.queryByTestId('preview-newtab')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '附回聊天' }))
    await user.click(screen.getByTestId('preview-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('全螢幕切換', async () => {
    serve({ ...base, kind: 'markdown', text: '# a' })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    await screen.findByTestId('markdown-preview')
    await user.click(screen.getByTestId('preview-fullscreen'))
    expect(screen.getByTestId('preview-fullscreen-layer')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('preview-fullscreen-layer')).not.toBeInTheDocument()
  })

  it('文字類提供搜尋，命中數顯示在程式碼檢視', async () => {
    serve({ ...base, title: 'b.py', kind: 'code', text: 'alpha\nbeta\nalpha again\n', meta: { language: 'python' } })
    const user = userEvent.setup()
    view(<FilePreview source={path} />)
    await screen.findByTestId('code-preview')
    await user.click(screen.getByTestId('preview-search-toggle'))
    await user.type(screen.getByTestId('preview-search-input'), 'alpha')
    expect(await screen.findByTestId('code-hits')).toHaveTextContent('2')
  })
})
