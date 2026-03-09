import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api, APIError } from '../api/client'

export default function CheckEmail() {
  const location = useLocation()
  const email = (location.state as { email?: string })?.email ?? ''
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleResend() {
    if (!email || resending) return
    setError(null)
    setResending(true)
    try {
      await api.auth.resendVerification(email)
      setResent(true)
    } catch (err) {
      if (err instanceof APIError) {
        setError(err.message)
      } else {
        setError('Could not resend verification email')
      }
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0">
      <div className="max-w-md w-full space-y-6 p-8 bg-surface-1 border border-border-default rounded-md text-center">
        <div>
          <h1 className="text-3xl font-bold text-text-primary">Check your email</h1>
          <p className="mt-3 text-text-secondary">
            We sent a verification link to{' '}
            {email ? <span className="font-medium">{email}</span> : 'your email'}.
          </p>
          <p className="mt-2 text-sm text-text-tertiary">
            Click the link in the email to continue setting up your account.
            The link is valid for 24 hours.
          </p>
        </div>

        {error && (
          <div className="p-3 bg-danger/10 text-danger rounded text-sm">{error}</div>
        )}

        {resent ? (
          <p className="text-sm text-success">Verification email resent.</p>
        ) : (
          email && (
            <button
              onClick={handleResend}
              disabled={resending}
              className="text-sm text-brand hover:underline disabled:opacity-50"
            >
              {resending ? 'Resending...' : "Didn't get the email? Resend"}
            </button>
          )
        )}

        <p className="text-sm text-text-tertiary">
          <Link to="/register" className="text-brand hover:underline">
            Back to registration
          </Link>
        </p>
      </div>
    </div>
  )
}
