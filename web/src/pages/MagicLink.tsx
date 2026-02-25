import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function MagicLink() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>
  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-4 p-8 bg-white rounded-lg shadow text-center">
        <h1 className="text-3xl font-bold text-gray-900">Clawvisor</h1>
        <p className="text-gray-600">
          Use the magic link from your terminal to sign in.
        </p>
        <p className="text-sm text-gray-500">
          The server prints a one-time URL on startup. Paste it in your browser to get started.
        </p>
      </div>
    </div>
  )
}
