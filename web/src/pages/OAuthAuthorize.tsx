import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'

interface OAuthClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

export default function OAuthAuthorize() {
  const [searchParams] = useSearchParams()
  const [client, setClient] = useState<OAuthClient | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const clientId = searchParams.get('client_id') ?? ''
  const redirectUri = searchParams.get('redirect_uri') ?? ''
  const state = searchParams.get('state') ?? ''
  const codeChallenge = searchParams.get('code_challenge') ?? ''
  const scope = searchParams.get('scope') ?? ''

  useEffect(() => {
    if (!clientId) {
      setError('Missing client_id parameter')
      setLoading(false)
      return
    }
    // Fetch client info to display the name
    fetch(`/oauth/register?client_id=${encodeURIComponent(clientId)}`)
      .then(() => {
        // We don't have a GET endpoint for clients, but we have the client_id.
        // Just show the consent screen with what we have.
        setClient({ client_id: clientId, client_name: clientId, redirect_uris: [] })
        setLoading(false)
      })
      .catch(() => {
        setClient({ client_id: clientId, client_name: clientId, redirect_uris: [] })
        setLoading(false)
      })
  }, [clientId])

  async function handleApprove() {
    try {
      const result = await api.oauthApprove({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        scope,
      })
      // Redirect to the callback URL with the authorization code
      window.location.href = result.redirect_uri
    } catch (err: any) {
      setError(err.message ?? 'Authorization failed')
    }
  }

  function handleDeny() {
    const url = new URL(redirectUri)
    url.searchParams.set('error', 'access_denied')
    if (state) url.searchParams.set('state', state)
    window.location.href = url.toString()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 max-w-md w-full">
          <h1 className="text-xl font-semibold text-red-400 mb-2">Authorization Error</h1>
          <p className="text-gray-400">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold text-gray-100 mb-2">Authorize Connection</h1>
          <p className="text-gray-400 text-sm">
            <span className="text-gray-200 font-medium">{client?.client_name}</span>{' '}
            wants to connect as an agent to your Clawvisor instance.
          </p>
        </div>

        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-400 mb-2">This will allow the application to:</p>
          <ul className="text-sm text-gray-300 space-y-1">
            <li>View your service catalog</li>
            <li>Create and manage tasks</li>
            <li>Make gateway requests (subject to your approval settings)</li>
          </ul>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleDeny}
            className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700 text-sm font-medium transition-colors"
          >
            Deny
          </button>
          <button
            onClick={handleApprove}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Authorize
          </button>
        </div>
      </div>
    </div>
  )
}
