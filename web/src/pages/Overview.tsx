import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, type QueueItem, type Task, type AuditEntry, type Agent, type NotificationConfig, type ActivityBucket } from '../api/client'
import { formatDistanceToNow, format } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { serviceName, actionName, serviceBrand, formatServiceAction } from '../lib/services'
import { summarizeActions, OUTCOME_STYLE } from '../lib/queue-helpers'
import CountdownTimer from '../components/CountdownTimer'
import StatusBadge from '../components/StatusBadge'
import LifetimeBadge from '../components/LifetimeBadge'
import Onboarding from './Onboarding'

export default function Overview() {
  // Bundled overview data — 5s polling for live feel
  const { data: overview } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.overview.get(),
    refetchInterval: 5_000,
  })

  // Agents for name resolution
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  })

  // Services + notifications for onboarding
  const { data: services } = useQuery({
    queryKey: ['services'],
    queryFn: () => api.services.list(),
  })
  const { data: notificationsData } = useQuery({
    queryKey: ['notifications'],
    queryFn: (): Promise<NotificationConfig[]> => api.notifications.list(),
  })

  const agentMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of (agentsData ?? []) as Agent[]) {
      m.set(a.id, a.name)
    }
    return m
  }, [agentsData])

  const allServices = services?.services ?? []

  // Onboarding latch
  const onboardingDecided = useRef(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingInitial, setOnboardingInitial] = useState<number[]>([])

  useEffect(() => {
    if (onboardingDecided.current) return
    if (!services || agentsData === undefined || notificationsData === undefined) return
    onboardingDecided.current = true
    const hasService = (services.services ?? []).some(
      (s: { status: string; requires_activation?: boolean }) => s.status === 'activated' && (s.requires_activation ?? true)
    )
    const hasAgents = (agentsData ?? []).length > 0
    const hasTelegram = notificationsData.some((c: NotificationConfig) => c.channel === 'telegram' && c.config?.bot_token)
    const done: number[] = []
    if (hasService) done.push(1)
    if (hasAgents) done.push(2)
    if (hasTelegram) done.push(3)
    if (!hasService || !hasAgents) {
      setOnboardingInitial(done)
      setShowOnboarding(true)
    }
  }, [services, agentsData, notificationsData])

  const queueItems = overview?.queue ?? []
  const activeTasks = overview?.active_tasks ?? []
  const activity = overview?.activity ?? []

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>

      {/* Onboarding */}
      {showOnboarding && (
        <Onboarding
          allServices={allServices}
          initialCompleted={onboardingInitial}
          onDismiss={() => setShowOnboarding(false)}
        />
      )}

      {/* Queue section */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-lg font-semibold text-text-primary">Needs your attention</h2>
          {queueItems.length > 0 && (
            <span className="bg-warning text-surface-0 text-xs font-bold rounded px-2.5 py-0.5 font-mono">
              {queueItems.length}
            </span>
          )}
        </div>

        {queueItems.length === 0 ? (
          <div className="rounded-md border border-success/30 bg-success/10 px-5 py-4 flex items-center gap-3">
            <svg className="w-5 h-5 text-success shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span className="text-success font-medium">All clear — nothing needs your attention</span>
          </div>
        ) : (
          <div className="space-y-3">
            {queueItems.map(item =>
              item.type === 'approval' ? (
                <OverviewApprovalCard key={item.id} item={item} />
              ) : (
                <OverviewTaskCard
                  key={item.id}
                  item={item}
                  agentName={item.task ? (agentMap.get(item.task.agent_id) ?? item.task.agent_id.slice(0, 8)) : 'Unknown'}
                />
              )
            )}
          </div>
        )}
      </section>

      {/* Activity graph */}
      <section>
        <h2 className="text-lg font-semibold text-text-primary mb-3">Activity (last 60 min)</h2>
        {activity.length === 0 ? (
          <div className="rounded-md border border-border-subtle bg-surface-1 px-5 py-8 text-center text-sm text-text-tertiary">
            No activity in the last 60 minutes
          </div>
        ) : (
          <ActivityChart data={activity} />
        )}
      </section>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-text-primary">
              Active tasks
              <span className="ml-2 text-sm font-normal text-text-tertiary">{activeTasks.length}</span>
            </h2>
            <Link to="/dashboard/tasks" className="text-sm text-brand hover:underline">
              View all
            </Link>
          </div>
          <div className="space-y-3">
            {activeTasks.slice(0, 5).map(task => (
              <OverviewActiveTaskCard
                key={task.id}
                task={task}
                agentName={agentMap.get(task.agent_id) ?? task.agent_id.slice(0, 8)}
              />
            ))}
            {activeTasks.length > 5 && (
              <Link to="/dashboard/tasks" className="block text-center text-sm text-brand hover:underline py-1">
                +{activeTasks.length - 5} more
              </Link>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Activity chart ───────────────────────────────────────────────────────────

const OUTCOME_COLORS: Record<string, string> = {
  executed: '#22c55e',
  blocked: '#ef4444',
  pending: '#f97316',
}

interface ChartRow {
  time: string
  executed: number
  blocked: number
  pending: number
}

function ActivityChart({ data }: { data: ActivityBucket[] }) {
  const rows = useMemo(() => {
    // Build lookup from bucket timestamp → aggregated counts
    const counts = new Map<number, ChartRow>()
    for (const b of data) {
      const ms = new Date(b.bucket).getTime()
      if (!counts.has(ms)) {
        counts.set(ms, { time: '', executed: 0, blocked: 0, pending: 0 })
      }
      const row = counts.get(ms)!
      if (b.outcome === 'executed') row.executed += b.count
      else if (b.outcome === 'blocked' || b.outcome === 'restricted') row.blocked += b.count
      else row.pending += b.count
    }

    // Generate all 12 five-minute buckets covering the last hour
    const now = new Date()
    const startMs = now.getTime() - 60 * 60 * 1000
    const firstBucket = startMs - (startMs % (5 * 60 * 1000))
    const result: ChartRow[] = []
    for (let ms = firstBucket; ms <= now.getTime(); ms += 5 * 60 * 1000) {
      const t = new Date(ms)
      const label = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
      const existing = counts.get(ms)
      result.push(existing ? { ...existing, time: label } : { time: label, executed: 0, blocked: 0, pending: 0 })
    }
    return result
  }, [data])

  return (
    <div className="bg-surface-1 border border-border-default rounded-md p-4">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={rows}>
          <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#6b7280' }} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} width={30} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #1f2937', backgroundColor: '#161923', color: '#f0f1f3' }}
          />
          <Bar dataKey="executed" stackId="1" stroke={OUTCOME_COLORS.executed} fill={OUTCOME_COLORS.executed} fillOpacity={0.85} name="Executed" />
          <Bar dataKey="blocked" stackId="1" stroke={OUTCOME_COLORS.blocked} fill={OUTCOME_COLORS.blocked} fillOpacity={0.85} name="Blocked" />
          <Bar dataKey="pending" stackId="1" stroke={OUTCOME_COLORS.pending} fill={OUTCOME_COLORS.pending} fillOpacity={0.85} name="Pending" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Active task card (mirrors Tasks page TaskCard) ───────────────────────────

function OverviewActiveTaskCard({ task, agentName }: { task: Task; agentName: string }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const isStanding = task.lifetime === 'standing'

  const revokeMut = useMutation({
    mutationFn: () => api.tasks.revoke(task.id),
    onSuccess: () => {
      setResult('Revoked')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ['audit', { task_id: task.id }],
    queryFn: () => api.audit.list({ task_id: task.id, limit: 50 }),
    enabled: expanded,
    refetchInterval: (query) => expanded && task.request_count !== (query.state.data?.entries?.length ?? 0) ? 1_000 : false,
  })

  const auditEntries = auditData?.entries ?? []

  return (
    <div className="border border-border-default rounded-md bg-surface-1">
      {/* Clickable header */}
      <div
        className="p-5 space-y-3 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-text-primary">{task.purpose}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <StatusBadge status={task.status} />
              <LifetimeBadge lifetime={task.lifetime} />
              <span className="text-xs text-text-tertiary">
                {agentName} &middot; {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0 space-y-1">
            {!isStanding && task.expires_at && (
              <CountdownTimer expiresAt={task.expires_at} showLabel />
            )}
            {isStanding && (
              <span className="text-xs text-brand font-medium">No expiry</span>
            )}
            <div className="flex items-center gap-2 justify-end">
              {task.request_count > 0 && (
                <span className="text-xs text-text-tertiary">{task.request_count} request{task.request_count !== 1 ? 's' : ''}</span>
              )}
              <span className="text-xs text-text-secondary">{expanded ? '\u25B2' : '\u25BC'}</span>
            </div>
          </div>
        </div>

        {/* Authorized scopes — structured list */}
        <div className="space-y-1">
          {task.authorized_actions.map(a => (
            <div key={`${a.service}|${a.action}`} className="flex items-start gap-2 text-sm">
              <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${a.auto_execute ? 'bg-success' : 'bg-warning'}`} />
              <span className="text-text-secondary">
                {serviceName(a.service)}: {actionName(a.action)}
                {!a.auto_execute && <span className="text-warning text-xs ml-1">(approval)</span>}
              </span>
              {a.expected_use && (
                <span className="text-text-tertiary text-xs italic ml-auto">— {a.expected_use}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Result message */}
      {result && (
        <div className="px-5 pb-3">
          <div className="p-2 bg-surface-2 rounded text-sm text-text-tertiary">{result}</div>
        </div>
      )}

      {/* Revoke button */}
      {!result && task.status === 'active' && (
        <div className="flex gap-2 px-5 pb-4">
          <button
            onClick={() => revokeMut.mutate()}
            disabled={revokeMut.isPending}
            className="py-1.5 px-4 text-sm rounded bg-surface-2 text-text-primary hover:bg-surface-3 disabled:opacity-50"
          >
            {revokeMut.isPending ? 'Revoking...' : 'Revoke'}
          </button>
        </div>
      )}

      {/* Expanded audit entries */}
      {expanded && (
        <div className="border-t border-border-default px-5 py-4 space-y-2">
          <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide">Actions</div>
          {auditLoading && <div className="text-xs text-text-tertiary">Loading...</div>}
          {!auditLoading && auditEntries.length === 0 && (
            <div className="text-xs text-text-tertiary">No actions recorded yet.</div>
          )}
          {auditEntries.length > 0 && (
            <div className="bg-surface-2 border border-border-default rounded-md overflow-hidden">
              <table className="w-full">
                <thead className="bg-surface-2 text-xs text-text-tertiary font-medium">
                  <tr>
                    <th className="px-3 py-1.5 text-left">Time</th>
                    <th className="px-3 py-1.5 text-left">Service</th>
                    <th className="px-3 py-1.5 text-left">Action</th>
                    <th className="px-3 py-1.5 text-left">Outcome</th>
                    <th className="px-3 py-1.5 text-left">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map(e => (
                    <OverviewAuditRow key={e.id} entry={e} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OverviewAuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <tr
        className="border-t border-border-default hover:bg-surface-2 cursor-pointer text-xs"
        onClick={ev => { ev.stopPropagation(); setExpanded(e => !e) }}
      >
        <td className="px-3 py-1.5 text-text-tertiary whitespace-nowrap" title={format(new Date(entry.timestamp), 'PPpp')}>
          {formatDistanceToNow(new Date(entry.timestamp), { addSuffix: true })}
        </td>
        <td className="px-3 py-1.5">
          <span className="inline-flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serviceBrand(entry.service).dot}`} />
            {serviceName(entry.service)}
          </span>
        </td>
        <td className="px-3 py-1.5">{actionName(entry.action)}</td>
        <td className="px-3 py-1.5">
          <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${OUTCOME_STYLE[entry.outcome] ?? 'bg-surface-2 text-text-tertiary'}`}>
            {entry.outcome}
          </span>
        </td>
        <td className="px-3 py-1.5 text-text-tertiary">{entry.duration_ms}ms</td>
      </tr>
      {expanded && (
        <tr className="border-t border-border-default bg-surface-1">
          <td colSpan={5} className="px-3 py-2">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-text-tertiary font-medium mb-1">
                  {formatServiceAction(entry.service, entry.action)}
                </div>
                <pre className="bg-surface-2 border border-border-default rounded p-2 overflow-auto max-h-32 text-text-secondary text-[11px]">
                  {JSON.stringify(entry.params_safe, null, 2)}
                </pre>
              </div>
              <div className="space-y-1.5">
                {entry.reason && (
                  <div className="bg-brand/10 rounded p-1.5">
                    <div className="text-brand font-medium">Reason</div>
                    <div className="text-text-secondary">{entry.reason}</div>
                  </div>
                )}
                {entry.error_msg && (
                  <div><span className="text-text-tertiary">Error:</span> <span className="text-danger">{entry.error_msg}</span></div>
                )}
                {entry.safety_flagged && (
                  <div className="text-warning">Safety flagged{entry.safety_reason ? `: ${entry.safety_reason}` : ''}</div>
                )}
                {entry.verification && (
                  <div className="bg-warning/10 rounded p-1.5 space-y-1">
                    <div className="text-warning font-medium">Intent Verification</div>
                    <div className="flex gap-2 flex-wrap">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        entry.verification.param_scope === 'ok' ? 'bg-success/15 text-success'
                        : entry.verification.param_scope === 'violation' ? 'bg-danger/15 text-danger'
                        : 'bg-surface-2 text-text-tertiary'
                      }`}>params: {entry.verification.param_scope}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        entry.verification.reason_coherence === 'ok' ? 'bg-success/15 text-success'
                        : entry.verification.reason_coherence === 'incoherent' ? 'bg-danger/15 text-danger'
                        : entry.verification.reason_coherence === 'insufficient' ? 'bg-warning/15 text-warning'
                        : 'bg-surface-2 text-text-tertiary'
                      }`}>reason: {entry.verification.reason_coherence}</span>
                      {entry.verification.cached && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand/10 text-brand">cached</span>
                      )}
                    </div>
                    <div className="text-text-secondary text-[11px]">{entry.verification.explanation}</div>
                    <div className="text-text-tertiary text-[10px]">{entry.verification.model} &middot; {entry.verification.latency_ms}ms</div>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Queue cards (local, mutation wiring differs from Queue page) ─────────────

function OverviewApprovalCard({ item }: { item: QueueItem }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<string | null>(null)
  const [paramsOpen, setParamsOpen] = useState(false)
  const a = item.approval!

  const approveMut = useMutation({
    mutationFn: () => api.approvals.approve(a.request_id),
    onSuccess: (res) => {
      setResult(res.status === 'executed' ? 'Approved & executed' : `Outcome: ${res.status}`)
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
  })

  const denyMut = useMutation({
    mutationFn: () => api.approvals.deny(a.request_id),
    onSuccess: () => {
      setResult('Denied')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
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
            {serviceName(a.service)} &middot; {actionName(a.action)}
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
            <span>{paramsOpen ? '\u25BC' : '\u25B6'}</span> Parameters
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

function OverviewTaskCard({ item, agentName }: { item: QueueItem; agentName: string }) {
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
      qc.invalidateQueries({ queryKey: ['queue'] })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const denyMut = useMutation({
    mutationFn: () => isExpansion ? api.tasks.expandDeny(task.id) : api.tasks.deny(task.id),
    onSuccess: () => {
      setResult(isExpansion ? 'Expansion denied' : 'Denied')
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-text-primary">{task.purpose}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <StatusBadge status={task.status} />
            <LifetimeBadge lifetime={task.lifetime} />
            <span className="text-xs text-text-tertiary">
              {agentName} &middot; {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
            </span>
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
          isExpansion ? 'bg-warning/15 text-warning' : 'bg-brand-muted text-brand'
        }`}>
          {isExpansion ? 'Scope expansion' : 'New task'}
        </span>
      </div>

      <p className="text-sm text-text-secondary">{summarizeActions(task.authorized_actions)}</p>

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
