import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import { Layout } from './components/Layout'
import { Loading } from './components/QueryState'
import { AgentsPage } from './pages/AgentsPage'
import { KanbanPage } from './pages/KanbanPage'
import { LoginPage } from './pages/LoginPage'
import { SettingsPage } from './pages/SettingsPage'
import { WorkbenchPage } from './pages/WorkbenchPage'
import { WorkflowsPage } from './pages/WorkflowsPage'
import { moduleRoutes } from './modules/registry'
import { BotsApp } from './modules/bots/BotsApp'
import { SetupGate, SetupPage } from './modules/setup'

function RequireAuth({ children }: { children: JSX.Element }) {
  const { member, ready } = useAuth()
  const loc = useLocation()
  if (!ready) return <Loading />
  if (!member) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return children
}

export function App() {
  const { member } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={member ? <Navigate to="/today" replace /> : <LoginPage />} />
      <Route
        path="/setup"
        element={
          <RequireAuth>
            <SetupPage />
          </RequireAuth>
        }
      />
      {/* Bots 訊息介面：自帶全螢幕殼，不套舊 Layout */}
      {['/bots', '/bots/:roomId'].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <RequireAuth>
              <SetupGate>
                <BotsApp />
              </SetupGate>
            </RequireAuth>
          }
        />
      ))}
      <Route
        element={
          <RequireAuth>
            <SetupGate>
              <Layout />
            </SetupGate>
          </RequireAuth>
        }
      >
        {/* 首頁是「今天」；/ 保留成轉址，舊書籤不會 404 */}
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/kanban" element={<KanbanPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {moduleRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  )
}
