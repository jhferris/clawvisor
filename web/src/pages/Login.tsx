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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8 p-8 bg-white rounded-lg shadow">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Clawvisor</h1>
          <h2 className="mt-2 text-lg text-gray-600">Sign in to your account</h2>
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
        )}

        {passkeysEnabled && (
          <div className="space-y-3">
            <button
              onClick={handlePasskeyLogin}
              disabled={isSubmitting}
              className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Authenticating...' : 'Sign in with passkey'}
            </button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">or sign in with password</span>
              </div>
            </div>
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 px-4 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600">
          Don't have an account?{' '}
          <Link to="/register" className="text-blue-600 hover:underline">
            Register
          </Link>
        </p>
      </div>
    </div>
  )
}
