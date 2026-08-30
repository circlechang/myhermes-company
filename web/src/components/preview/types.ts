// 統一預覽的資料形狀，對應後端 studio/modules/preview（見 docs/API.md「Preview」）
export type PreviewKind =
  | 'markdown' | 'code' | 'html' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image' | 'binary'

export interface PreviewHeading {
  level: number
  text: string
  id: string
}
export interface SheetMerge {
  row: number
  col: number
  rowspan: number
  colspan: number
}
export interface PreviewSheet {
  name: string
  rows: string[][]
  merges: SheetMerge[]
  freeze: { rows: number; cols: number }
  numeric_cols: number[]
  total_rows: number
  total_cols: number
  truncated: boolean
  hidden: boolean
}
export interface PreviewPage {
  index: number
  /** pdf */
  text?: string
  /** pptx */
  title?: string
  body?: string[]
  notes?: string
  images?: string[]
  tables?: string[][][]
}
export interface PreviewMeta {
  encoding?: string
  language?: string
  lines?: number
  inline?: boolean
  headings?: PreviewHeading[]
  counts?: { paragraphs: number; tables: number; images: number; headings: number }
  doc_title?: string
  author?: string
  sheet_names?: string[]
  slides?: number
  pages?: number
  width?: number
  height?: number
  format?: string
  mode?: string
  animated?: boolean
  exif?: Record<string, string>
  delimiter?: string
  numeric_cols?: number[]
  total_rows?: number
  total_cols?: number
  truncated?: boolean
}
export interface PreviewData {
  kind: PreviewKind
  title: string
  path: string
  size: number
  mtime: number
  mime: string
  meta: PreviewMeta
  warnings: string[]
  text?: string
  html?: string
  rows?: string[][]
  sheets?: PreviewSheet[]
  pages?: PreviewPage[]
  url?: string
  download_url?: string
  source_path?: string
  too_large?: boolean
  error?: string
}

/** 三種來源：檔案路徑、純文字內容、已知 URL（自帶內容的模組用） */
export type PreviewSource =
  | { kind: 'path'; path: string; format?: PreviewKind | 'auto' }
  | { kind: 'inline'; text: string; title?: string; format?: PreviewKind | 'auto'; language?: string }
  | {
      kind: 'url'
      url: string
      title?: string
      format?: PreviewKind | 'auto'
      /** 由呼叫端提供的補充 metadata（沒有就不顯示） */
      size?: number
      mtime?: number
      downloadUrl?: string
    }

export const isTextKind = (k: PreviewKind) => k === 'markdown' || k === 'code' || k === 'html'
export const isTableKind = (k: PreviewKind) => k === 'csv' || k === 'xlsx'
