import { createContext, useContext, useState, useCallback } from 'react'
import api from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('kalika_user'))
    } catch {
      return null
    }
  })

  const login = useCallback(async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    localStorage.setItem('kalika_token', data.access_token)
    localStorage.setItem('kalika_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('kalika_token')
    localStorage.removeItem('kalika_user')
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}