import { useState, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../hooks/useAuth'

export default function TOTPVerify() {
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const pendingToken: string = (location.state as any)?.pending_token ?? ''

  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const resp = await api.auth.totp.verify(pendingToken, code)
      setSession(resp.access_token, resp.refresh_token, resp.user)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.message ?? 'Invalid code')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!pendingToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full p-8 bg-white rounded-lg shadow text-center">
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Session expired</h2>
          <p className="text-sm text-gray-600 mb-4">Please sign in again.</p>
          <button
            onClick={() => navigate('/login')}
            className="py-2 px-4 bg-blue-600 text-white rounded font-medium hover:bg-blue-700"
          >
            Go to login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-6 p-8 bg-white rounded-lg shadow">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Clawvisor</h1>
          <h2 className="mt-2 text-lg text-gray-600">Two-factor authentication</h2>
          <p className="mt-1 text-sm text-gray-500">
            Enter the 6-digit code from your authenticator app.
          </p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && (
            <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
          )}

          <div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="block w-full rounded border border-gray-300 px-3 py-3 text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
              autoComplete="one-time-code"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || code.length !== 6}
            className="w-full py-2 px-4 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Verifying...' : 'Verify'}
          </button>
        </form>

        <button
          onClick={() => navigate('/login')}
          className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
        >
          Back to login
        </button>
      </div>
    </div>
  )
}
