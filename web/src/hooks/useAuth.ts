import { useState, useEffect, useCallback } from 'react'
import { api, setAccessToken, type User } from '../api/client'

const REFRESH_TOKEN_KEY = 'clawvisor_refresh_token'

interface AuthState {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
}

interface AuthActions {
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export function useAuth(): AuthState & AuthActions {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // On mount, try to restore session from stored refresh token
  useEffect(() => {
    const storedRefresh = localStorage.getItem(REFRESH_TOKEN_KEY)
    if (!storedRefresh) {
      setIsLoading(false)
      return
    }
    api.auth
      .refresh(storedRefresh)
      .then((resp) => {
        setAccessToken(resp.access_token)
        localStorage.setItem(REFRESH_TOKEN_KEY, resp.refresh_token)
        setUser(resp.user)
      })
      .catch(() => {
        localStorage.removeItem(REFRESH_TOKEN_KEY)
        setAccessToken(null)
      })
      .finally(() => setIsLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const resp = await api.auth.login(email, password)
    setAccessToken(resp.access_token)
    localStorage.setItem(REFRESH_TOKEN_KEY, resp.refresh_token)
    setUser(resp.user)
  }, [])

  const register = useCallback(async (email: string, password: string) => {
    const resp = await api.auth.register(email, password)
    setAccessToken(resp.access_token)
    localStorage.setItem(REFRESH_TOKEN_KEY, resp.refresh_token)
    setUser(resp.user)
  }, [])

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY) ?? undefined
    await api.auth.logout(refreshToken).catch(() => {})
    setAccessToken(null)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    setUser(null)
  }, [])

  return {
    user,
    isLoading,
    isAuthenticated: user !== null,
    login,
    register,
    logout,
  }
}
