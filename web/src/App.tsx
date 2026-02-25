import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'
import Register from './pages/Register'
import MagicLink from './pages/MagicLink'
import Dashboard from './pages/Dashboard'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, authMode } = useAuth()
  if (isLoading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>
  if (!isAuthenticated) {
    return <Navigate to={authMode === 'magic_link' ? '/magic-link' : '/login'} replace />
  }
  return <>{children}</>
}

export default function App() {
  const { isAuthenticated, isLoading, authMode } = useAuth()

  const unauthRedirect = authMode === 'magic_link' ? '/magic-link' : '/login'

  return (
    <Routes>
      <Route
        path="/"
        element={
          isLoading ? null : isAuthenticated ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <Navigate to={unauthRedirect} replace />
          )
        }
      />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/magic-link" element={<MagicLink />} />
      <Route
        path="/dashboard/*"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
