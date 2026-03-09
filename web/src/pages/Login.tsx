import { useState, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { api, APIError } from '../api/client'
import { isWebAuthnAvailable, startAuthentication } from '../lib/webauthn'

export default function Login() {
  const { login, setSession, features } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const passkeysEnabled = features?.passkeys && isWebAuthnAvailable()

  async function handlePasskeyLogin() {
    setError(null)
    setIsSubmitting(true)
    try {
      const beginResp = await api.auth.passkey.loginBegin()
      const credential = await startAuthentication(beginResp.options)
      const finishResp = await api.auth.passkey.loginFinish(beginResp.challenge_id, credential)
      setSession(finishResp.access_token, finishResp.refresh_token, finishResp.user)
      navigate('/dashboard')
    } catch (err: any) {
      if (err instanceof APIError) {
        setError(err.message)
      } else if (err?.name === 'NotAllowedError') {
        setError('Passkey authentication was cancelled')
      } else {
        setError(err?.message ?? 'Passkey authentication failed')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const resp = await login(email, password)
      if (resp.status === 'requires_totp') {
        navigate('/totp-verify', { state: { pending_token: resp.pending_token } })
      } else if (resp.status === 'setup_required') {
        navigate('/setup-auth', { state: { setup_token: resp.setup_token, upgrade: true } })
      } else {
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
          <h2 className="mt-2 text-lg text-text-secondary">Sign in to your account</h2>
        </div>

        {error && (
          <div className="p-3 bg-danger/10 text-danger rounded text-sm">{error}</div>
        )}

        {passkeysEnabled && (
          <div className="space-y-3">
            <button
              onClick={handlePasskeyLogin}
              disabled={isSubmitting}
              className="w-full py-3 px-4 bg-brand text-surface-0 rounded font-medium hover:bg-brand-strong disabled:opacity-50"
            >
              {isSubmitting ? 'Authenticating...' : 'Sign in with passkey'}
            </button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border-subtle" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-surface-1 text-text-tertiary">or sign in with password</span>
              </div>
            </div>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
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

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-text-secondary">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded border border-border-default bg-surface-0 text-text-primary px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 px-4 bg-brand text-surface-0 rounded font-medium hover:bg-brand-strong disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-text-secondary">
          Don't have an account?{' '}
          <Link to="/register" className="text-brand hover:underline">
            Register
          </Link>
        </p>
      </div>
    </div>
  )
}
