import { NavLink, Routes, Route, Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../hooks/useAuth'
import { useEventStream } from '../hooks/useEventStream'
import { api } from '../api/client'
import Services from './Services'
import Restrictions from './Restrictions'
import Audit from './Audit'
import Agents from './Agents'
import Settings from './Settings'
import Overview from './Overview'
import Tasks from './Tasks'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', end: true, icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> },
  { to: '/dashboard/tasks', label: 'Tasks', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> },
  { to: '/dashboard/services', label: 'Services', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg> },
  { to: '/dashboard/restrictions', label: 'Restrictions', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
  { to: '/dashboard/agents', label: 'Agents', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg> },
  { to: '/dashboard/audit', label: 'Gateway Log', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> },
  { to: '/dashboard/settings', label: 'Settings', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg> },
]

export default function Dashboard() {
  const { user, logout } = useAuth()

  // SSE event stream for instant dashboard updates
  useEventStream()

  // Poll queue count for sidebar badge (fallback; SSE pushes invalidations)
  const { data: queueData } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.queue.list(),
    refetchInterval: 60_000,
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
        <ul className="flex-1 py-2">
          {navItems.map(({ to, label, end, icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center justify-between px-4 py-2 text-sm font-medium transition-colors border-l-2 ${
                    isActive
                      ? 'bg-brand-muted text-brand border-l-brand'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary border-l-transparent'
                  }`
                }
              >
                <span className="flex items-center gap-3">
                  {icon}
                  {label}
                </span>
                {label === 'Dashboard' && queueCount > 0 && (
                  <span className="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-warning text-surface-0">
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
