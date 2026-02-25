import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { NotificationConfig } from '../api/client'
import { useNavigate } from 'react-router-dom'
import { api, APIError } from '../api/client'
import { useAuth } from '../hooks/useAuth'

export default function Settings() {
  return (
    <div className="p-8 space-y-10">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
      <TelegramSection />
      <PasswordSection />
      <DangerZone />
    </div>
  )
}

// ── Telegram notification config ─────────────────────────────────────────────

function TelegramSection() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null)

  // Pairing flow state
  const [botToken, setBotToken] = useState('')
  const [pairingId, setPairingId] = useState<string | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [pairingStatus, setPairingStatus] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [pairingSuccess, setPairingSuccess] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: configs } = useQuery({
    queryKey: ['notifications'],
    queryFn: (): Promise<NotificationConfig[]> => api.notifications.list(),
  })

  const tg = configs?.find((c: NotificationConfig) => c.channel === 'telegram')
  const isConfigured = Boolean(tg?.config?.bot_token)

  // Stop polling on unmount or when done
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  // Start pairing
  const startMut = useMutation({
    mutationFn: () => api.notifications.startPairing(botToken),
    onSuccess: (data) => {
      setPairingId(data.pairing_id)
      setBotUsername(data.bot_username)
      setPairingStatus('polling')
      setError(null)
      setPairingSuccess(false)
      // Start polling for status
      stopPolling()
      pollRef.current = setInterval(async () => {
        try {
          const s = await api.notifications.pairingStatus(data.pairing_id)
          setPairingStatus(s.status)
          if (s.status === 'ready' || s.status === 'expired' || s.status === 'confirmed') {
            stopPolling()
          }
        } catch {
          // ignore polling errors
        }
      }, 2000)
    },
    onError: (err: Error) => setError(err.message),
  })

  // Confirm pairing
  const confirmMut = useMutation({
    mutationFn: () => api.notifications.confirmPairing(pairingId!, code),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
      setPairingSuccess(true)
      setPairingId(null)
      setPairingStatus(null)
      setBotToken('')
      setCode('')
      setError(null)
      setTimeout(() => setPairingSuccess(false), 5000)
    },
    onError: (err: Error) => setError(err.message),
  })

  const deleteMut = useMutation({
    mutationFn: () => api.notifications.deleteTelegram(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
      setBotToken('')
      setTestResult(null)
      setPairingId(null)
      setPairingStatus(null)
      setPairingSuccess(false)
    },
  })

  const testMut = useMutation({
    mutationFn: () => api.notifications.testTelegram(),
    onSuccess: () => {
      setTestResult('success')
      setTimeout(() => setTestResult(null), 5000)
    },
    onError: (err: Error) => {
      setError(err.message)
      setTestResult('error')
      setTimeout(() => setTestResult(null), 5000)
    },
  })

  // Reset pairing flow
  const resetPairing = () => {
    stopPolling()
    setPairingId(null)
    setPairingStatus(null)
    setBotUsername(null)
    setCode('')
    setError(null)
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Telegram Notifications</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Receive approval requests and status updates via Telegram.
        </p>
      </div>

      {error && <div className="text-sm text-red-600 max-w-lg">{error}</div>}
      {pairingSuccess && <div className="text-sm text-green-600 max-w-lg">Paired successfully!</div>}

      {isConfigured ? (
        /* ── Configured state ──────────────────────────────────── */
        <div className="bg-white border rounded-lg p-5 space-y-3 max-w-lg">
          <div className="text-sm text-gray-700 space-y-1">
            <p><span className="font-medium text-gray-600">Bot token:</span> {tg!.config.bot_token.slice(0, 8)}...{tg!.config.bot_token.slice(-4)}</p>
            <p><span className="font-medium text-gray-600">Chat ID:</span> {tg!.config.chat_id}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => testMut.mutate()}
              disabled={testMut.isPending}
              className="px-4 py-1.5 text-sm rounded border border-blue-300 text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              {testMut.isPending ? 'Sending...' : 'Send test message'}
            </button>
            <button
              onClick={() => { deleteMut.mutate(); resetPairing() }}
              disabled={deleteMut.isPending}
              className="text-sm text-red-500 hover:text-red-700"
            >
              Remove
            </button>
            <button
              onClick={resetPairing}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Re-pair
            </button>
          </div>
          {testResult === 'success' && (
            <div className="text-sm text-green-600">Test message sent! Check your Telegram.</div>
          )}
          {testResult === 'error' && (
            <div className="text-sm text-red-600">Test failed. Check your Telegram bot settings.</div>
          )}
        </div>
      ) : !pairingId ? (
        /* ── Step 1: Enter bot token ──────────────────────────── */
        <div className="space-y-3 max-w-lg">
          <div className="bg-gray-50 border rounded-lg p-4 text-sm text-gray-700 space-y-2">
            <p className="font-medium text-gray-800">Setup steps:</p>
            <ol className="list-decimal list-inside space-y-1.5 text-gray-600">
              <li>Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">@BotFather</a></li>
              <li>Send <code className="bg-gray-200 px-1 rounded text-xs">/newbot</code> and follow the prompts to create your bot</li>
              <li>Copy the <strong>bot token</strong> BotFather gives you</li>
            </ol>
          </div>
          <div className="bg-white border rounded-lg p-5 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-600">Bot Token</label>
              <input
                type="password"
                value={botToken}
                onChange={e => { setBotToken(e.target.value); setError(null) }}
                placeholder="1234567890:ABCDEF..."
                className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <button
              onClick={() => startMut.mutate()}
              disabled={startMut.isPending || !botToken}
              className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {startMut.isPending ? 'Validating...' : 'Start Pairing'}
            </button>
          </div>
        </div>
      ) : pairingStatus === 'polling' ? (
        /* ── Step 2: Waiting for /start ───────────────────────── */
        <div className="bg-white border rounded-lg p-5 space-y-3 max-w-lg">
          <p className="text-sm text-gray-700">
            Open{' '}
            <a
              href={`https://t.me/${botUsername}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline font-medium"
            >
              @{botUsername}
            </a>{' '}
            in Telegram and send <code className="bg-gray-200 px-1 rounded text-xs">/start</code>
          </p>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <svg className="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Waiting for your message...
          </div>
          <button onClick={resetPairing} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        </div>
      ) : pairingStatus === 'ready' ? (
        /* ── Step 3: Enter pairing code ───────────────────────── */
        <div className="bg-white border rounded-lg p-5 space-y-3 max-w-lg">
          <p className="text-sm text-gray-700">
            Enter the pairing code from your Telegram chat:
          </p>
          <input
            value={code}
            onChange={e => { setCode(e.target.value.toUpperCase()); setError(null) }}
            placeholder="ABCD1234"
            maxLength={8}
            className="block w-48 text-sm rounded border border-gray-300 px-3 py-1.5 font-mono tracking-widest uppercase focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => confirmMut.mutate()}
              disabled={confirmMut.isPending || code.length !== 8}
              className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {confirmMut.isPending ? 'Confirming...' : 'Confirm'}
            </button>
            <button onClick={resetPairing} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>
        </div>
      ) : pairingStatus === 'expired' ? (
        /* ── Expired ──────────────────────────────────────────── */
        <div className="bg-white border rounded-lg p-5 space-y-3 max-w-lg">
          <p className="text-sm text-red-600">Pairing session expired. Please try again.</p>
          <button
            onClick={resetPairing}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            Start Over
          </button>
        </div>
      ) : null}
    </section>
  )
}

// ── Password change ────────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const changeMut = useMutation({
    mutationFn: () => api.auth.updateMe(current, next),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError(null)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    },
    onError: (err: Error) => setError(err instanceof APIError ? err.message : 'Failed to change password'),
  })

  function handleSubmit() {
    if (next !== confirm) { setError('New passwords do not match'); return }
    if (next.length < 8) { setError('Password must be at least 8 characters'); return }
    setError(null)
    changeMut.mutate()
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-800">Change Password</h2>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {success && <div className="text-sm text-green-600">Password updated successfully.</div>}
      <div className="bg-white border rounded-lg p-5 space-y-3 max-w-lg">
        <div>
          <label className="text-xs font-medium text-gray-600">Current password</label>
          <input
            type="password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">New password</label>
          <input
            type="password"
            value={next}
            onChange={e => setNext(e.target.value)}
            className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Confirm new password</label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="mt-1 block w-full text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={changeMut.isPending || !current || !next}
          className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {changeMut.isPending ? 'Updating…' : 'Update Password'}
        </button>
      </div>
    </section>
  )
}

// ── Danger zone ────────────────────────────────────────────────────────────────

function DangerZone() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const deleteMut = useMutation({
    mutationFn: () => api.auth.deleteMe(password),
    onSuccess: async () => {
      await logout()
      navigate('/login')
    },
    onError: (err: Error) => setError(err instanceof APIError ? err.message : 'Failed to delete account'),
  })

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold text-red-700">Danger Zone</h2>
      <div className="border border-red-200 rounded-lg p-5 space-y-3 max-w-lg">
        <div>
          <p className="text-sm font-medium text-gray-800">Delete Account</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Permanently delete your account and all data. This cannot be undone.
          </p>
        </div>
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="text-sm px-3 py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50"
          >
            Delete my account
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-red-600">Enter your password to confirm deletion:</p>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Your password"
              className="block w-full text-sm rounded border border-red-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending || !password}
                className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleteMut.isPending ? 'Deleting…' : 'Confirm Delete'}
              </button>
              <button
                onClick={() => { setOpen(false); setPassword(''); setError(null) }}
                className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
