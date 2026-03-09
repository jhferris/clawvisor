import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getAccessToken } from '../api/client'

/**
 * Connects to the SSE event stream and invalidates React Query caches
 * on server-pushed events. EventSource auto-reconnects on disconnect.
 */
export function useEventStream() {
  const qc = useQueryClient()

  useEffect(() => {
    const token = getAccessToken()
    if (!token) return

    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)

    es.addEventListener('queue', () => {
      qc.invalidateQueries({ queryKey: ['overview'] })
      qc.invalidateQueries({ queryKey: ['queue'] })
    })

    es.addEventListener('tasks', () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
    })

    es.addEventListener('audit', (e) => {
      const { id } = JSON.parse(e.data)
      qc.invalidateQueries({ queryKey: ['audit'] })
      if (id) {
        qc.invalidateQueries({ queryKey: ['audit', { task_id: id }] })
      }
      qc.invalidateQueries({ queryKey: ['overview'] })
    })

    return () => es.close()
  }, [qc])
}
