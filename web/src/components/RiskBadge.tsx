const RISK_BADGE: Record<string, { bg: string; dot: string; text: string }> = {
  low:      { bg: 'bg-success/15', dot: 'bg-success', text: 'text-success' },
  medium:   { bg: 'bg-warning/15', dot: 'bg-warning', text: 'text-warning' },
  high:     { bg: 'bg-risk-orange/15', dot: 'bg-risk-orange', text: 'text-risk-orange' },
  critical: { bg: 'bg-danger/15', dot: 'bg-danger', text: 'text-danger' },
  unknown:  { bg: 'bg-surface-2', dot: 'bg-text-tertiary', text: 'text-text-tertiary' },
}

export default function RiskBadge({ level }: { level: string }) {
  const badge = RISK_BADGE[level]
  if (!badge) return null
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-mono font-medium px-2 py-0.5 rounded ${badge.bg} ${badge.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
      {level} risk
    </span>
  )
}
