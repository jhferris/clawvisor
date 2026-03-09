import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, type QueueItem, type Agent } from '../api/client'
import { formatDistanceToNow } from 'date-fns'
import { serviceName, actionName } from '../lib/services'
import { summarizeActions } from '../lib/queue-helpers'
import CountdownTimer from '../components/CountdownTimer'
import StatusBadge from '../components/StatusBadge'
import LifetimeBadge from '../components/LifetimeBadge'

// ── Approval card ─────────────────────────────────────────────────────────────

function ApprovalCard({ item }: { item: QueueItem }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<string | null>(null)
  const [paramsOpen, setParamsOpen] = useState(false)
  const a = item.approval!

  const approveMut = useMutation({
    mutationFn: () => api.approvals.approve(a.request_id),
    onSuccess: (res) => {
      setResult(res.status === 'executed' ? 'Approved & executed' : `Outcome: ${res.status}`)
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['approvals'] })
    },
  })

  const denyMut = useMutation({
    mutationFn: () => api.approvals.deny(a.request_id),
    onSuccess: () => {
      setResult('Denied')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['approvals'] })
    },
  })

  const isPending = approveMut.isPending || denyMut.isPending
  const hasParams = Object.keys(a.params ?? {}).length > 0

  if (result) {
    return (
      <div className="border border-border-default rounded-md bg-surface-1 p-5">
        <div className="p-3 bg-surface-2 rounded text-sm text-text-tertiary">{result}</div>
      </div>
    )
  }

  return (
    <div className="border border-border-default rounded-md bg-surface-1 p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-text-primary">
            {serviceName(a.service)} · {actionName(a.action)}
          </p>
          {a.reason && (
            <p className="text-sm text-text-tertiary italic mt-1">"{a.reason}"</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.expires_at && <CountdownTimer expiresAt={item.expires_at} />}
          <span className="text-xs px-2 py-0.5 rounded bg-brand/10 text-brand font-medium">Request</span>
        </div>
      </div>

      {hasParams && (
        <div>
          <button
            onClick={() => setParamsOpen(o => !o)}
            className="text-xs text-text-tertiary hover:text-text-primary flex items-center gap-1"
          >
            <span>{paramsOpen ? '▼' : '▶'}</span> Parameters
          </button>
          {paramsOpen && (
            <pre className="mt-1 text-xs bg-surface-2 border border-border-default rounded p-3 overflow-auto max-h-64 font-mono text-text-secondary">
              {JSON.stringify(a.params, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => approveMut.mutate()}
          disabled={isPending}
          className="flex-1 py-2 text-sm rounded bg-success text-surface-0 hover:bg-green-400 disabled:opacity-50 font-medium"
        >
          {approveMut.isPending ? 'Approving...' : 'Approve'}
        </button>
        <button
          onClick={() => denyMut.mutate()}
          disabled={isPending}
          className="flex-1 py-2 text-sm rounded bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 disabled:opacity-50 font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

// ── Task card ─────────────────────────────────────────────────────────────────

function TaskQueueCard({ item, agentName }: { item: QueueItem; agentName: string }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<string | null>(null)
  const task = item.task!
  const isExpansion = task.status === 'pending_scope_expansion'
  const needsApproval = task.status === 'pending_approval'

  const approveMut = useMutation({
    mutationFn: () => isExpansion ? api.tasks.expandApprove(task.id) : api.tasks.approve(task.id),
    onSuccess: () => {
      setResult(isExpansion ? 'Expansion approved' : 'Approved')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const denyMut = useMutation({
    mutationFn: () => isExpansion ? api.tasks.expandDeny(task.id) : api.tasks.deny(task.id),
    onSuccess: () => {
      setResult(isExpansion ? 'Expansion denied' : 'Denied')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const isPending = approveMut.isPending || denyMut.isPending

  if (result) {
    return (
      <div className="border border-border-default rounded-md bg-surface-1 p-5">
        <div className="p-3 bg-surface-2 rounded text-sm text-text-tertiary">{result}</div>
      </div>
    )
  }

  return (
    <div className="border border-warning/30 rounded-md bg-surface-1 p-5 space-y-3">
      {/* Header — purpose as hero */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-text-primary">{task.purpose}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <StatusBadge status={task.status} />
            <LifetimeBadge lifetime={task.lifetime} />
            <span className="text-xs text-text-tertiary">
              {agentName} · {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
            </span>
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
          isExpansion ? 'bg-warning/15 text-warning' : 'bg-brand-muted text-brand'
        }`}>
          {isExpansion ? 'Scope expansion' : 'New task'}
        </span>
      </div>

      {/* Authorized actions summary */}
      <p className="text-sm text-text-secondary">{summarizeActions(task.authorized_actions)}</p>

      {/* Scope expansion detail */}
      {isExpansion && task.pending_action && (
        <div className="bg-warning/10 border border-warning/30 rounded-md p-3 space-y-2">
          <div className="text-xs font-medium text-warning">Scope expansion requested</div>
          <div className="flex items-center gap-2">
            <span className="text-xs bg-surface-1 border border-warning/30 rounded px-2 py-0.5 text-warning">
              {serviceName(task.pending_action.service)}: {actionName(task.pending_action.action)}
            </span>
            {task.pending_action.auto_execute && (
              <span className="text-xs text-success font-medium">auto-execute</span>
            )}
          </div>
          {task.pending_reason && (
            <p className="text-xs text-warning italic">"{task.pending_reason}"</p>
          )}
        </div>
      )}

      {/* Agent-declared expected use */}
      {needsApproval && task.authorized_actions.some(a => a.expected_use) && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-text-tertiary">Agent-declared expected use:</div>
          {task.authorized_actions.filter(a => a.expected_use).map(a => (
            <div key={`${a.service}|${a.action}`} className="flex items-start gap-2 text-xs">
              <span className="text-text-tertiary w-40 shrink-0 truncate" title={`${a.service}:${a.action}`}>
                {serviceName(a.service)}: {actionName(a.action)}
              </span>
              <span className="text-text-secondary italic">{a.expected_use}</span>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => approveMut.mutate()}
          disabled={isPending}
          className="flex-1 py-2 text-sm rounded bg-success text-surface-0 hover:bg-green-400 disabled:opacity-50 font-medium"
        >
          {approveMut.isPending ? 'Approving...' : isExpansion ? 'Approve Expansion' : 'Approve Task'}
        </button>
        <button
          onClick={() => denyMut.mutate()}
          disabled={isPending}
          className="flex-1 py-2 text-sm rounded bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 disabled:opacity-50 font-medium"
        >
          {isExpansion ? 'Deny Expansion' : 'Deny'}
        </button>
      </div>
    </div>
  )
}

// ── Queue page ────────────────────────────────────────────────────────────────

export default function Queue() {
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const [deepLinkResult, setDeepLinkResult] = useState<string | null>(null)

  // Deep link mutations for approvals
  const deepApproveRequest = useMutation({
    mutationFn: (requestId: string) => api.approvals.approve(requestId),
    onSuccess: (_data, requestId) => {
      setDeepLinkResult(`Request ${requestId.slice(0, 8)}... approved.`)
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (err: Error) => setDeepLinkResult(`Approve failed: ${err.message}`),
  })

  const deepDenyRequest = useMutation({
    mutationFn: (requestId: string) => api.approvals.deny(requestId),
    onSuccess: (_data, requestId) => {
      setDeepLinkResult(`Request ${requestId.slice(0, 8)}... denied.`)
      qc.invalidateQueries({ queryKey: ['approvals'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (err: Error) => setDeepLinkResult(`Deny failed: ${err.message}`),
  })

  // Deep link mutations for tasks
  const deepApproveTask = useMutation({
    mutationFn: (taskId: string) => api.tasks.approve(taskId),
    onSuccess: () => { setDeepLinkResult('Task approved.'); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (err: Error) => setDeepLinkResult(`Approve failed: ${err.message}`),
  })

  const deepDenyTask = useMutation({
    mutationFn: (taskId: string) => api.tasks.deny(taskId),
    onSuccess: () => { setDeepLinkResult('Task denied.'); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['overview'] }) },
    onError: (err: Error) => setDeepLinkResult(`Deny failed: ${err.message}`),
  })

  // Handle deep link actions
  useEffect(() => {
    const action = searchParams.get('action')
    const requestId = searchParams.get('request_id')
    const taskId = searchParams.get('task_id')
    if (!action) return

    setSearchParams({}, { replace: true })

    if (requestId) {
      if (action === 'approve') deepApproveRequest.mutate(requestId)
      else if (action === 'deny') deepDenyRequest.mutate(requestId)
    } else if (taskId) {
      if (action === 'approve') deepApproveTask.mutate(taskId)
      else if (action === 'deny') deepDenyTask.mutate(taskId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.overview.get(),
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

  const items = data?.queue ?? []

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold text-text-primary">Pending</h1>

      {/* Deep link result banner */}
      {deepLinkResult && (
        <div className="rounded-md border border-brand/30 bg-brand/10 px-5 py-3 flex items-center justify-between">
          <span className="text-brand text-sm">{deepLinkResult}</span>
          <button onClick={() => setDeepLinkResult(null)} className="text-brand text-xs hover:underline">Dismiss</button>
        </div>
      )}

      {isLoading && <div className="text-sm text-text-tertiary">Loading...</div>}

      {!isLoading && items.length === 0 && (
        <div className="rounded-md border border-success/30 bg-success/10 px-5 py-4 flex items-center gap-3">
          <svg className="w-5 h-5 text-success shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span className="text-success font-medium">All clear — nothing needs your attention</span>
        </div>
      )}

      <div className="space-y-3">
        {items.map(item => (
          item.type === 'approval' ? (
            <ApprovalCard key={item.id} item={item} />
          ) : (
            <TaskQueueCard
              key={item.id}
              item={item}
              agentName={item.task ? (agentMap.get(item.task.agent_id) ?? item.task.agent_id.slice(0, 8)) : 'Unknown'}
            />
          )
        ))}
      </div>
    </div>
  )
}
