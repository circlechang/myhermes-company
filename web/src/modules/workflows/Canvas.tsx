// 畫布：React Flow 包裝，支援縮放、鍵盤刪除、複製、自動排版、唯讀模式（快照）
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type OnSelectionChangeParams, type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type ForwardedRef } from 'react'
import { autoLayout, defaultNode, duplicateNode, fromFlow, toFlow, type FlowEdge, type FlowNode } from './graph'
import { edgeTypes, nodeTypes } from './nodes'
import type { NodeKind, WfEdge, WfNode } from './types'

export interface CanvasHandle {
  getGraph: () => { nodes: WfNode[]; edges: WfEdge[]; viewport: Viewport }
  addNode: (kind: NodeKind, titles?: Record<string, string>) => void
  autoLayout: () => void
  fitView: () => void
  updateNode: (id: string, patch: Partial<WfNode>) => void
  updateEdge: (id: string, patch: { on?: WfEdge['on']; loop_back?: boolean }) => void
  duplicateSelected: () => void
  deleteSelected: () => void
  /** 整張圖換掉（載入範例模板） */
  setGraph: (g: { nodes: WfNode[]; edges: WfEdge[] }) => void
}

export interface CanvasProps {
  initial: { nodes: WfNode[]; edges: WfEdge[]; viewport?: Viewport }
  readOnly?: boolean
  nodeStatus?: Record<string, { status?: string; streaming?: string }>
  edgeDecisions?: Record<string, boolean>
  onSelect?: (sel: { node?: WfNode; edge?: WfEdge }) => void
  onChange?: () => void
  onNodeDoubleClick?: (id: string) => void
}

function Inner({ initial, readOnly, nodeStatus, edgeDecisions, onSelect, onChange, onNodeDoubleClick }: CanvasProps, ref: ForwardedRef<CanvasHandle>) {
  const init = toFlow(initial)
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(init.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(init.edges)
  const rf = useReactFlow<FlowNode, FlowEdge>()
  const [selected, setSelected] = useState<OnSelectionChangeParams | null>(null)
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  // 執行狀態注入 data（不改 graph 本體）
  useEffect(() => {
    if (!nodeStatus) return
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: nodeStatus[n.id]?.status, streaming: nodeStatus[n.id]?.streaming } })))
  }, [nodeStatus, setNodes])
  useEffect(() => {
    if (!edgeDecisions) return
    setEdges((es) => es.map((e) => ({ ...e, data: { on: e.data?.on ?? 'always', loop_back: !!e.data?.loop_back, decision: edgeDecisions[e.id] } as FlowEdge['data'] })))
  }, [edgeDecisions, setEdges])

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly) return
      setEdges((es) => addEdge({ ...c, id: `${c.source}->${c.target}:${c.sourceHandle ?? 'output'}`, type: 'wf', sourceHandle: c.sourceHandle ?? 'output', targetHandle: 'input', data: { on: 'always', loop_back: false } }, es))
      changeRef.current?.()
    },
    [readOnly, setEdges],
  )

  useImperativeHandle(ref, () => ({
    getGraph: () => ({ ...fromFlow(rf.getNodes(), rf.getEdges()), viewport: rf.getViewport() }),
    addNode: (kind, titles) => {
      const vp = rf.getViewport()
      const n = defaultNode(kind, { x: Math.round(-vp.x / vp.zoom + 80 + Math.random() * 60), y: Math.round(-vp.y / vp.zoom + 80 + Math.random() * 60) }, titles)
      setNodes((ns) => ns.map((x) => ({ ...x, selected: false })).concat({ id: n.id, type: 'wf', position: n.position!, data: { node: n }, selected: true }))
      changeRef.current?.()
    },
    autoLayout: () => {
      const g = fromFlow(rf.getNodes(), rf.getEdges())
      const pos = autoLayout(g.nodes, g.edges)
      setNodes((ns) => ns.map((n) => ({ ...n, position: pos[n.id] ?? n.position })))
      setTimeout(() => rf.fitView({ padding: 0.2 }), 30)
      changeRef.current?.()
    },
    fitView: () => rf.fitView({ padding: 0.2 }),
    updateNode: (id, patch) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, node: { ...n.data.node, ...patch } } } : n)))
      changeRef.current?.()
    },
    updateEdge: (id, patch) => {
      setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { on: patch.on ?? e.data?.on ?? 'always', loop_back: patch.loop_back ?? !!e.data?.loop_back } } : e)))
      changeRef.current?.()
    },
    duplicateSelected: () => {
      const sel = rf.getNodes().filter((n) => n.selected)
      if (!sel.length) return
      const copies = sel.map((n) => duplicateNode({ ...n.data.node, position: n.position }))
      setNodes((ns) => ns.map((x) => ({ ...x, selected: false })).concat(copies.map((c) => ({ id: c.id, type: 'wf' as const, position: c.position!, data: { node: c }, selected: true }))))
      changeRef.current?.()
    },
    deleteSelected: () => {
      const ids = new Set(rf.getNodes().filter((n) => n.selected).map((n) => n.id))
      const eids = new Set(rf.getEdges().filter((e) => e.selected).map((e) => e.id))
      setNodes((ns) => ns.filter((n) => !ids.has(n.id)))
      setEdges((es) => es.filter((e) => !eids.has(e.id) && !ids.has(e.source) && !ids.has(e.target)))
      changeRef.current?.()
    },
    setGraph: (g) => {
      const f = toFlow({ nodes: g.nodes, edges: g.edges })
      setNodes(f.nodes)
      setEdges(f.edges)
      setTimeout(() => rf.fitView({ padding: 0.2 }), 30)
      changeRef.current?.()
    },
  }))

  const onSelectionChange = useCallback(
    (p: OnSelectionChangeParams) => {
      setSelected(p)
      const n = p.nodes[0] as FlowNode | undefined
      const e = p.edges[0] as FlowEdge | undefined
      onSelect?.({ node: n ? { ...n.data.node, position: n.position } : undefined, edge: e ? fromFlow([], [e]).edges[0] : undefined })
    },
    [onSelect],
  )
  void selected

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={(c) => {
        onNodesChange(c)
        if (!readOnly && c.some((x) => x.type === 'remove' || x.type === 'position')) changeRef.current?.()
      }}
      onEdgesChange={(c) => {
        onEdgesChange(c)
        if (!readOnly && c.some((x) => x.type === 'remove')) changeRef.current?.()
      }}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      onNodeDoubleClick={(_, n) => onNodeDoubleClick?.(n.id)}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      multiSelectionKeyCode="Shift"
      defaultViewport={initial.viewport}
      fitView={!initial.viewport}
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ type: 'wf' }}
      proOptions={{ hideAttribution: true }}
      className="bg-zinc-50 dark:bg-zinc-950"
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="!bg-zinc-100 dark:!bg-zinc-900" />
    </ReactFlow>
  )
}

const InnerRef = forwardRef(Inner)

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  return (
    <ReactFlowProvider>
      <InnerRef {...props} ref={ref} />
    </ReactFlowProvider>
  )
})
