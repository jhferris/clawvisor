import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Restriction } from '../api/client'
import { formatDistanceToNow } from 'date-fns'

export default function Restrictions() {
  const qc = useQueryClient()

  const [service, setService] = useState('')
  const [action, setAction] = useState('*')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: restrictions, isLoading } = useQuery({
    queryKey: ['restrictions'],
    queryFn: () => api.restrictions.list(),
  })

  const createMut = useMutation({
    mutationFn: () => api.restrictions.create(service.trim(), action.trim() || '*', reason.trim()),
    onSuccess: () => {
      setService('')
      setAction('*')
      setReason('')
      setFormError(null)
      qc.invalidateQueries({ queryKey: ['restrictions'] })
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.restrictions.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restrictions'] })
    },
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!service.trim()) {
      setFormError('Service is required.')
      return
    }
    setFormError(null)
    createMut.mutate()
  }

  const rows = restrictions ?? []

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Restrictions</h1>
      <p className="text-sm text-gray-500">
        Hard blocks applied before policy evaluation. Any gateway request matching a restriction is
        rejected immediately, regardless of policy rules.
      </p>

      {/* Add form */}
      <div className="bg-white border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Add Restriction</h2>
        <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">
              Service <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. google.gmail"
              value={service}
              onChange={e => setService(e.target.value)}
              className="text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 w-48"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Action</label>
            <input
              type="text"
              placeholder="* or e.g. send_email"
              value={action}
              onChange={e => setAction(e.target.value)}
              className="text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 w-44"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-48">
            <label className="text-xs text-gray-500 font-medium">Reason</label>
            <input
              type="text"
              placeholder="Optional description"
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="text-sm rounded border border-gray-300 px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400 w-full"
            />
          </div>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="py-1.5 px-4 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {createMut.isPending ? 'Adding...' : 'Add Block'}
          </button>
        </form>
        {formError && (
          <p className="mt-2 text-xs text-red-600">{formError}</p>
        )}
      </div>

      {/* Restrictions table */}
      <div className="bg-white border rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="px-4 py-6 text-sm text-gray-400">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            No restrictions configured. Add a block above to prevent specific service actions.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 text-left">Service</th>
                <th className="px-4 py-2 text-left">Action</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Restriction) => (
                <tr key={r.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm font-mono text-gray-900">{r.service}</td>
                  <td className="px-4 py-2 text-sm font-mono text-gray-700">{r.action}</td>
                  <td className="px-4 py-2 text-sm text-gray-500">
                    {r.reason ? r.reason : <span className="text-gray-300 italic">—</span>}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-400">
                    {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => deleteMut.mutate(r.id)}
                      disabled={deleteMut.isPending}
                      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
