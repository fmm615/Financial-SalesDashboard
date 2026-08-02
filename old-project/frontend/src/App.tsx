import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import NavBar from './components/shared/NavBar'
import ExecutiveCockpit from './views/ExecutiveCockpit'
import OperationalDashboard from './views/OperationalDashboard/index'
import ReportsView from './views/ReportsView'
import Login from './views/Login'

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F7F3]">
      <NavBar />
      <main className="pt-14">{children}</main>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('pb_token')
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/cockpit"
          element={
            <RequireAuth>
              <AppShell><ExecutiveCockpit /></AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/ops"
          element={
            <RequireAuth>
              <AppShell><OperationalDashboard /></AppShell>
            </RequireAuth>
          }
        />
        <Route
          path="/reports"
          element={
            <RequireAuth>
              <AppShell><ReportsView /></AppShell>
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to="/cockpit" replace />} />
        <Route path="*" element={<Navigate to="/cockpit" replace />} />
      </Routes>
    </BrowserRouter>
  )
}