// Shared helpers for Queue, Tasks, and Overview pages. Pure functions, no React.

import { serviceName, actionName } from './services'

export const STATUS_STYLES: Record<string, string> = {
  pending_approval: 'bg-warning/15 text-warning',
  pending_scope_expansion: 'bg-warning/15 text-warning',
  active: 'bg-success/15 text-success',
  completed: 'bg-surface-2 text-text-tertiary',
  expired: 'bg-surface-2 text-text-tertiary',
  denied: 'bg-danger/15 text-danger',
  revoked: 'bg-surface-2 text-text-tertiary',
}

export const STATUS_LABELS: Record<string, string> = {
  pending_approval: 'Pending Approval',
  pending_scope_expansion: 'Scope Expansion',
  active: 'Active',
  completed: 'Completed',
  expired: 'Expired',
  denied: 'Denied',
  revoked: 'Revoked',
}

export const OUTCOME_STYLE: Record<string, string> = {
  executed: 'bg-success/15 text-success',
  blocked: 'bg-danger/15 text-danger',
  restricted: 'bg-warning/15 text-warning',
  pending: 'bg-warning/15 text-warning',
  denied: 'bg-surface-2 text-text-tertiary',
  error: 'bg-danger/15 text-danger',
  timeout: 'bg-surface-2 text-text-tertiary',
}

export function summarizeActions(actions: { service: string; action: string; auto_execute: boolean }[]): string {
  const groups = new Map<string, { auto: string[]; manual: string[] }>()
  for (const a of actions) {
    const svc = serviceName(a.service)
    if (!groups.has(svc)) groups.set(svc, { auto: [], manual: [] })
    const g = groups.get(svc)!
    if (a.auto_execute) {
      g.auto.push(actionName(a.action).toLowerCase())
    } else {
      g.manual.push(actionName(a.action).toLowerCase())
    }
  }

  const parts: string[] = []
  for (const [svc, g] of groups) {
    if (g.auto.length > 0) parts.push(`Can ${joinList(g.auto)} on ${svc}`)
    if (g.manual.length > 0) parts.push(`Can ${joinList(g.manual)} on ${svc} with approval`)
  }
  return parts.join(' \u00b7 ') || 'No actions authorized'
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
}
