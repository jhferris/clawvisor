import { STATUS_STYLES, STATUS_LABELS } from '../lib/queue-helpers'

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold ${STATUS_STYLES[status] ?? 'bg-surface-2 text-text-tertiary'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}
