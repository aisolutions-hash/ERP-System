import axios from 'axios'

// Dev: Vite proxy forwards /api -> backend (strips prefix).
// Prod (Cloud Run): FastAPI serves frontend + backend from same origin, no /api prefix.
const api = axios.create({
  baseURL: import.meta.env.PROD ? '/' : '/api',
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('kalika_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('kalika_token')
      localStorage.removeItem('kalika_user')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  },
)

export default api