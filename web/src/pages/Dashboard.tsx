import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../hooks/useAuth'
import { api } from '../api/client'
import Services from './Services'
import Restrictions from './Restrictions'
import Audit from './Audit'
import Agents from './Agents'
import Settings from './Settings'
import Overview from './Overview'
import Tasks from './Tasks'
import Queue from './Queue'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/dashboard/queue', label: 'Pending' },
  { to: '/dashboard/tasks', label: 'Tasks' },
  { to: '/dashboard/services', label: 'Services' },
  { to: '/dashboard/restrictions', label: 'Restrictions' },
  { to: '/dashboard/agents', label: 'Agents' },
  { to: '/dashboard/audit', label: 'Gateway Log' },
  { to: '/dashboard/settings', label: 'Settings' },
]

export default function Dashboard() {
  const { user, logout } = useAuth()

  // Poll unified queue for badge + floating panel
  const { data: queueData } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.queue.list(),
    refetchInterval: 15_000,
  })
  const queueCount = queueData?.total ?? 0

  return (
    <div className="min-h-screen bg-surface-0 flex">
      {/* Sidebar */}
      <nav className="w-56 bg-surface-1 border-r border-border-default flex flex-col shrink-0">
        <div className="px-4 py-5 border-b border-border-default">
          <span className="font-bold text-lg tracking-tight text-text-primary flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="w-5 h-5" />
            Clawvisor
          </span>
        </div>
        <ul className="flex-1 py-3 space-y-0.5 px-2">
          {navItems.map(({ to, label, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-muted text-brand'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                  }`
                }
              >
                {label}
                {label === 'Pending' && queueCount > 0 && (
                  <span className="ml-auto bg-warning text-surface-0 text-xs font-bold rounded font-mono w-5 h-5 flex items-center justify-center">
                    {queueCount > 9 ? '9+' : queueCount}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3 border-t border-border-default text-sm space-y-1">
          <div className="truncate text-text-secondary">{user?.email}</div>
          <button
            onClick={logout}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 min-w-0 overflow-auto">
        <Routes>
          <Route index element={<Overview />} />
          <Route path="queue" element={<Queue />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="services" element={<Services />} />
          <Route path="restrictions" element={<Restrictions />} />
          <Route path="audit" element={<Audit />} />
          <Route path="agents" element={<Agents />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>

    </div>
  )
}
