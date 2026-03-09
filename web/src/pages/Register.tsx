import { useState, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { api, APIError, setAccessToken } from '../api/client'

const REFRESH_TOKEN_KEY = 'clawvisor_refresh_token'

export default function Register() {
  const { authMode } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isPasskeyMode = authMode === 'passkey'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const resp = await api.auth.register(email, isPasskeyMode ? undefined : password)
      if (resp.status === 'verify_email') {
        // Non-local with email verification: check your email
        navigate('/check-email', { state: { email } })
      } else if (resp.setup_token) {
        // Non-local without email verification: direct to auth setup
        navigate('/setup-auth', { state: { setup_token: resp.setup_token } })
      } else if (resp.access_token) {
        // Local mode: direct login
        setAccessToken(resp.access_token)
        localStorage.setItem(REFRESH_TOKEN_KEY, resp.refresh_token!)
        navigate('/dashboard')
      }
    } catch (err) {
      if (err instanceof APIError) {
        setError(err.message)
      } else {
        setError('An unexpected error occurred')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0">
      <div className="max-w-md w-full space-y-8 p-8 bg-surface-1 border border-border-default rounded-md">
        <div>
          <h1 className="text-3xl font-bold text-text-primary">Clawvisor</h1>
          <h2 className="mt-2 text-lg text-text-secondary">Create your account</h2>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {error && (
            <div className="p-3 bg-danger/10 text-danger rounded text-sm">{error}</div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-text-secondary">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded border border-border-default bg-surface-0 text-text-primary px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand"
            />
          </div>

          {!isPasskeyMode && (
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-text-secondary">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded border border-border-default bg-surface-0 text-text-primary px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand"
              />
              <p className="mt-1 text-xs text-text-tertiary">Minimum 8 characters</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 px-4 bg-brand text-surface-0 rounded font-medium hover:bg-brand-strong disabled:opacity-50"
          >
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-text-secondary">
          Already have an account?{' '}
          <Link to="/login" className="text-brand hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
