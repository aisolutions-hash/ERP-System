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

export async function downloadFile(url, fallbackName = 'download') {
  try {
    const res = await api.get(url, { responseType: 'blob' })
    const cd = res.headers?.['content-disposition'] || ''
    const m = cd.match(/filename=(.+)/)
    const filename = m ? m[1].replace(/["']/g, '').trim() : fallbackName
    const blobUrl = window.URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(blobUrl)
  } catch (err) {
    if (!err.response || err.response.status !== 401) {
      alert(err.response?.data?.detail || 'Download failed')
    }
  }
}

export default api