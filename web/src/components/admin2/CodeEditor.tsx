// CodeMirror 6 編輯器（檔案／Skill／記憶共用）。jsdom 沒有 layout API，測試環境退回 textarea。
import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, type LanguageSupport } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'

export function languageFor(name: string): LanguageSupport | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'md':
    case 'markdown':
      return markdown()
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'py':
      return python()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'json':
    case 'jsonl':
      return json()
    case 'html':
    case 'htm':
    case 'svg':
      return html()
    case 'css':
      return css()
    default:
      return null
  }
}

const IS_TEST = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)

export function CodeEditor({
  value,
  onChange,
  filename = '',
  readOnly = false,
  height = '100%',
  ariaLabel,
}: {
  value: string
  onChange?: (v: string) => void
  filename?: string
  readOnly?: boolean
  height?: string
  ariaLabel?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const ro = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (IS_TEST || !host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        lang.current.of(languageFor(filename) ?? []),
        ro.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
        }),
        EditorView.theme({ '&': { height, fontSize: '13px' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    if (v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])
  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageFor(filename) ?? []) })
  }, [filename])
  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  if (IS_TEST) {
    return (
      <textarea
        aria-label={ariaLabel}
        className="input h-full min-h-[200px] font-mono"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
      />
    )
  }
  return <div ref={host} aria-label={ariaLabel} className="h-full min-h-[200px] overflow-hidden rounded-md border border-zinc-300 bg-white text-zinc-900 dark:border-zinc-700" style={{ height }} />
}
