import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { formatDistanceToNow } from 'date-fns'

export default function Agents() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  })

  const createMut = useMutation({
    mutationFn: () => api.agents.create(name),
    onSuccess: (agent) => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      setNewToken(agent.token ?? null)
      setName('')
      setFormError(null)
    },
    onError: (err: Error) => setFormError(err.message),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.agents.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-2xl font-bold text-text-primary">Agents</h1>
      <p className="text-sm text-text-tertiary">
        An agent is any AI system (Claude, a custom bot, etc.) that you want to give controlled access to your services.
        Each agent gets a unique token — paste it into your agent's configuration to connect it to Clawvisor.
      </p>

      {/* New token display */}
      {newToken && (
        <div className="bg-success/10 border border-success/30 rounded-md p-4 space-y-2">
          <p className="text-sm font-medium text-success">Agent created — copy your token now, it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-surface-1 border border-success/30 rounded px-3 py-2 text-xs font-mono text-text-primary break-all">
              {newToken}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(newToken)}
              className="text-xs px-3 py-1.5 rounded border border-success/30 text-success hover:bg-success/10"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setNewToken(null)} className="text-xs text-success hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <section className="bg-surface-1 border border-border-default rounded-md p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-secondary">Create Agent</h2>
        {formError && <div className="text-xs text-danger">{formError}</div>}
        <div className="flex gap-3">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Agent name"
            className="flex-1 text-sm rounded border border-border-default bg-surface-0 text-text-primary px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand placeholder:text-text-tertiary"
          />
          <button
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending || !name.trim()}
            className="px-4 py-1.5 text-sm rounded bg-brand text-surface-0 hover:bg-brand-strong disabled:opacity-50"
          >
            {createMut.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </section>

      {/* Agent list */}
      {isLoading && <div className="text-sm text-text-tertiary">Loading…</div>}

      {!isLoading && (!agents || agents.length === 0) && (
        <div className="text-sm text-text-tertiary text-center py-8">No agents yet. Create one above.</div>
      )}

      <div className="space-y-2">
        {agents?.map(agent => (
          <div key={agent.id} className="bg-surface-1 border border-border-default rounded-md px-5 py-4 flex items-center justify-between">
            <div>
              <span className="font-medium text-text-primary">{agent.name}</span>
              <p className="text-xs text-text-tertiary mt-0.5">
                Created {formatDistanceToNow(new Date(agent.created_at), { addSuffix: true })} · {agent.id}
              </p>
            </div>
            <button
              onClick={() => {
                if (confirm(`Revoke agent "${agent.name}"? Any running agents using this token will stop working.`)) {
                  deleteMut.mutate(agent.id)
                }
              }}
              disabled={deleteMut.isPending}
              className="text-xs px-3 py-1.5 rounded bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
