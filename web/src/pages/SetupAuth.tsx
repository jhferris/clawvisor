import { useState, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { api, setAccessToken, type AuthResponse } from '../api/client'
import { useAuth } from '../hooks/useAuth'
import { isWebAuthnAvailable, startRegistration } from '../lib/webauthn'

const REFRESH_TOKEN_KEY = 'clawvisor_refresh_token'

type Step = 'choose' | 'passkey' | 'password' | 'totp'

export default function SetupAuth() {
  const { setSession } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const setupToken: string = (location.state as any)?.setup_token ?? ''
  const isUpgrade = (location.state as any)?.upgrade === true

  const [step, setStep] = useState<Step>('choose')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Password + TOTP flow state
  const [password, setPassword] = useState('')
  const [totpQR, setTotpQR] = useState<string | null>(null)
  const [totpSecret, setTotpSecret] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')

  function completeAuth(resp: AuthResponse) {
    setSession(resp.access_token, resp.refresh_token, resp.user)
    navigate('/dashboard', { replace: true })
  }

  async function handlePasskey() {
    setError(null)
    setIsSubmitting(true)
    try {
      const beginResp = await api.auth.passkey.registerBegin(setupToken)
      const credential = await startRegistration(beginResp.options)
      const finishResp = await api.auth.passkey.registerFinish(setupToken, beginResp.challenge_id, credential)
      completeAuth(finishResp)
    } catch (err: any) {
      setError(err.message ?? 'Passkey registration failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSetPassword(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      // Setup password returns session tokens so we can call TOTP setup
      const pwResp = await api.auth.setupPassword(password, setupToken) as AuthResponse
      setAccessToken(pwResp.access_token)
      localStorage.setItem(REFRESH_TOKEN_KEY, pwResp.refresh_token)
      // Now set up TOTP (uses the session token we just stored)
      const totp = await api.auth.totp.setup()
      setTotpQR(totp.qr_data_url)
      setTotpSecret(totp.secret)
      setStep('totp')
    } catch (err: any) {
      setError(err.message ?? 'Failed to set password')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleConfirmTOTP(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      await api.auth.totp.confirm(totpCode)
      // TOTP confirmed — we already have session tokens from password setup
      navigate('/dashboard', { replace: true })
    } catch (err: any) {
      setError(err.message ?? 'Invalid TOTP code')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!setupToken) {
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
          <h2 className="mt-2 text-lg text-gray-600">
            {isUpgrade ? 'Secure your account' : 'Set up authentication'}
          </h2>
          {isUpgrade && (
            <p className="mt-1 text-sm text-amber-600">
              Password-only login is no longer supported. Please add a passkey or enable TOTP.
            </p>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
        )}

        {step === 'choose' && (
          <div className="space-y-3">
            {isWebAuthnAvailable() && (
              <button
                onClick={handlePasskey}
                disabled={isSubmitting}
                className="w-full py-3 px-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 text-left"
              >
                <div className="font-medium">Set up passkey</div>
                <div className="text-sm text-blue-200 mt-0.5">Recommended &mdash; use Face ID, Touch ID, or your security key</div>
              </button>
            )}
            <button
              onClick={() => setStep('password')}
              className="w-full py-3 px-4 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 text-left"
            >
              <div className="font-medium">Use password instead</div>
              <div className="text-sm text-gray-500 mt-0.5">Requires TOTP authenticator app for 2FA</div>
            </button>
          </div>
        )}

        {step === 'password' && (
          <form className="space-y-4" onSubmit={handleSetPassword}>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Create a password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">Minimum 8 characters</p>
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2 px-4 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Setting up...' : 'Continue to TOTP setup'}
            </button>
            <button
              type="button"
              onClick={() => setStep('choose')}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              Back
            </button>
          </form>
        )}

        {step === 'totp' && (
          <form className="space-y-4" onSubmit={handleConfirmTOTP}>
            <p className="text-sm text-gray-600">
              Scan this QR code with your authenticator app (Google Authenticator, 1Password, etc.)
            </p>
            {totpQR && (
              <div className="flex justify-center">
                <img src={totpQR} alt="TOTP QR Code" className="w-48 h-48" />
              </div>
            )}
            {totpSecret && (
              <div className="text-center">
                <p className="text-xs text-gray-500 mb-1">Or enter this code manually:</p>
                <code className="text-sm bg-gray-100 px-3 py-1 rounded font-mono select-all">{totpSecret}</code>
              </div>
            )}
            <div>
              <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700">
                Enter 6-digit code
              </label>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete="one-time-code"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting || totpCode.length !== 6}
              className="w-full py-2 px-4 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Verifying...' : 'Verify and finish'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
