import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams, Link } from 'react-router-dom'
import { api, type Agent } from '../api/client'
import TaskCard from '../components/TaskCard'

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All tasks' },
  { value: 'actionable', label: 'Needs action' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'expired', label: 'Expired' },
  { value: 'denied', label: 'Denied' },
  { value: 'revoked', label: 'Revoked' },
]

export default function Tasks() {
  const [filter, setFilter] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const [deepLinkResult, setDeepLinkResult] = useState<string | null>(null)

  const deepApprove = useMutation({
    mutationFn: (taskId: string) => api.tasks.approve(taskId),
    onSuccess: () => { setDeepLinkResult('Task approved.'); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (err: Error) => setDeepLinkResult(`Approve failed: ${err.message}`),
  })
  const deepDeny = useMutation({
    mutationFn: (taskId: string) => api.tasks.deny(taskId),
    onSuccess: () => { setDeepLinkResult('Task denied.'); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (err: Error) => setDeepLinkResult(`Deny failed: ${err.message}`),
  })
  const deepExpandApprove = useMutation({
    mutationFn: (taskId: string) => api.tasks.expandApprove(taskId),
    onSuccess: () => { setDeepLinkResult('Scope expansion approved.'); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (err: Error) => setDeepLinkResult(`Expansion approve failed: ${err.message}`),
  })
  const deepExpandDeny = useMutation({
    mutationFn: (taskId: string) => api.tasks.expandDeny(taskId),
    onSuccess: () => { setDeepLinkResult('Scope expansion denied.'); qc.invalidateQueries({ queryKey: ['tasks'] }) },
    onError: (err: Error) => setDeepLinkResult(`Expansion deny failed: ${err.message}`),
  })

  // Handle deep link actions from Telegram buttons
  useEffect(() => {
    const action = searchParams.get('action')
    const taskId = searchParams.get('task_id')
    if (!action || !taskId) return

    setSearchParams({}, { replace: true })

    switch (action) {
      case 'approve': deepApprove.mutate(taskId); break
      case 'deny': deepDeny.mutate(taskId); break
      case 'expand_approve': deepExpandApprove.mutate(taskId); break
      case 'expand_deny': deepExpandDeny.mutate(taskId); break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.tasks.list(),
    refetchInterval: 10_000,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  })

  const agentMap = new Map<string, string>()
  for (const a of (agentsData ?? []) as Agent[]) {
    agentMap.set(a.id, a.name)
  }

  const allTasks = data?.tasks ?? []

  const filtered = allTasks.filter(t => {
    if (!filter) return true
    if (filter === 'actionable') return t.status === 'pending_approval' || t.status === 'pending_scope_expansion'
    return t.status === filter
  })

  // Sort: actionable first, then active, then by created_at desc
  const sorted = [...filtered].sort((a, b) => {
    const priority = (s: string) => {
      if (s === 'pending_approval' || s === 'pending_scope_expansion') return 0
      if (s === 'active') return 1
      return 2
    }
    const pa = priority(a.status), pb = priority(b.status)
    if (pa !== pb) return pa - pb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  const actionableCount = allTasks.filter(
    t => t.status === 'pending_approval' || t.status === 'pending_scope_expansion'
  ).length

  return (
    <div className="p-8 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-text-primary">Tasks</h1>
          {actionableCount > 0 && (
            <span className="bg-warning text-surface-0 text-xs font-bold rounded px-2.5 py-0.5 font-mono">
              {actionableCount} awaiting action
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          className="text-sm text-brand hover:underline"
        >
          Refresh
        </button>
      </div>

      {/* Deep link result banner */}
      {deepLinkResult && (
        <div className="rounded-md border border-brand/30 bg-brand/10 px-5 py-3 flex items-center justify-between">
          <span className="text-brand text-sm">{deepLinkResult}</span>
          <button onClick={() => setDeepLinkResult(null)} className="text-brand text-xs hover:underline">Dismiss</button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="text-sm rounded border border-border-default bg-surface-0 text-text-primary px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand"
        >
          {STATUS_FILTER_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="text-sm text-text-tertiary">Loading...</div>}

      {!isLoading && sorted.length === 0 && (
        <div className="text-sm text-text-tertiary py-8 text-center">
          {filter
            ? 'No tasks match this filter.'
            : <>When your agent requests permission to run a task, it'll appear here for your approval.{(agentsData ?? []).length === 0 && (<>{' '}<Link to="/dashboard/agents" className="text-brand hover:underline">Create an agent</Link> to get started.</>)}</>
          }
        </div>
      )}

      {/* Task list */}
      <div className="space-y-3">
        {sorted.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            agentName={agentMap.get(task.agent_id) ?? task.agent_id.slice(0, 8)}
          />
        ))}
      </div>
    </div>
  )
}
