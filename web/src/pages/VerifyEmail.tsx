import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, APIError } from '../api/client'

export default function VerifyEmail() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') ?? ''
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(true)

  useEffect(() => {
    if (!token) {
      setError('Missing verification token')
      setVerifying(false)
      return
    }

    let cancelled = false
    async function verify() {
      try {
        const result = await api.auth.verifyEmail(token)
        if (!cancelled) {
          navigate('/setup-auth', { state: { setup_token: result.setup_token }, replace: true })
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof APIError) {
            setError(err.message)
          } else {
            setError('Verification failed. The link may have expired.')
          }
          setVerifying(false)
        }
      }
    }
    verify()
    return () => { cancelled = true }
  }, [token, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-6 p-8 bg-white rounded-lg shadow text-center">
        {verifying ? (
          <>
            <h1 className="text-2xl font-bold text-gray-900">Verifying your email...</h1>
            <p className="text-gray-500">Please wait a moment.</p>
          </>
        ) : error ? (
          <>
            <h1 className="text-2xl font-bold text-gray-900">Verification failed</h1>
            <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
            <p className="text-sm text-gray-500">
              The link may have expired or already been used.
            </p>
            <Link
              to="/register"
              className="inline-block mt-2 text-blue-600 hover:underline text-sm"
            >
              Register again
            </Link>
          </>
        ) : null}
      </div>
    </div>
  )
}
