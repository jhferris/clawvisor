export default function LifetimeBadge({ lifetime }: { lifetime?: string }) {
  if (!lifetime || lifetime === 'session') return null
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-brand-muted text-brand"
      title="This task does not expire and remains active until revoked"
    >
      Ongoing
    </span>
  )
}
