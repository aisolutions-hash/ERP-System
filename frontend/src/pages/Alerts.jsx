import { useEffect, useState } from 'react'
import { RefreshCw, CheckCheck, Mail, MailOpen, BellRing, AlertTriangle, Circle, CheckCircle2 } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard } from '../components/ui'

const PRIORITY_CLS = {
  CRITICAL: 'bg-red-100 text-red-700',
  HIGH: 'bg-amber-100 text-amber-700',
  MEDIUM: 'bg-blue-100 text-blue-700',
  LOW: 'bg-gray-100 text-gray-600',
}

const STATUS_CLS = {
  OPEN: 'bg-slate-100 text-slate-600',
  RESOLVED: 'bg-green-100 text-green-700',
}

export default function Alerts() {
  const [items, setItems] = useState([])
  const [typeFilter, setTypeFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const params = {}
      if (typeFilter) params.type = typeFilter
      if (priorityFilter) params.priority = priorityFilter
      if (statusFilter) params.status = statusFilter
      const res = await api.get('/alerts', { params })
      setItems(res.data || [])
    } catch { setItems([]) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [typeFilter, priorityFilter, statusFilter])

  const markRead = async (id) => { await api.patch(`/alerts/${id}`, { is_read: true }); load() }
  const markAllRead = async () => { await api.post('/alerts/mark-all-read'); load() }

  const types = [...new Set(items.map((a) => a.type))].sort()
  const open = items.filter((a) => a.status === 'OPEN').length
  const critical = items.filter((a) => a.priority === 'CRITICAL').length
  const unread = items.filter((a) => !a.is_read).length

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Alert Center" subtitle="ERP-wide notifications & issues requiring attention"
        actions={
          <>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={markAllRead} className="btn btn-primary"><CheckCheck size={15} /> Mark all read</button>
          </>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total Alerts" value={items.length} icon={BellRing} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Open" value={open} icon={Circle} iconClass="bg-slate-100 text-slate-600" />
        <StatCard label="Critical" value={critical} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        <StatCard label="Unread" value={unread} icon={Mail} iconClass="bg-blue-50 text-blue-600" />
      </div>

      <Card actions={
        <div className="flex items-center gap-2 text-xs">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="input py-2">
            <option value="">All types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="input py-2">
            <option value="">All priorities</option>
            <option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input py-2">
            <option value="">All statuses</option><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option>
          </select>
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty text="No alerts" /> : (
          <div className="space-y-2">
            {items.map((a) => (
              <div key={a.id} className={`card p-3 flex items-start gap-3 ${a.is_read ? 'bg-gray-50' : ''}`}>
                {a.is_read ? <MailOpen size={16} className="text-slate-300 mt-0.5" /> : <Mail size={16} className="text-amber-500 mt-0.5" />}
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={PRIORITY_CLS[a.priority] || 'bg-gray-100 text-gray-600'}>{a.priority}</Badge>
                    <Badge className="bg-slate-100 text-slate-600">{a.type}</Badge>
                    <Badge className={STATUS_CLS[a.status] || 'bg-gray-100 text-gray-600'}>{a.status}</Badge>
                    <span className="text-xs text-slate-400">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-sm text-slate-800 mt-1">{a.message}</div>
                  {(a.entity_type || a.target_role) && (
                    <div className="text-xs text-slate-400 mt-1">
                      {a.entity_type && <span>Entity: {a.entity_type}{a.entity_id ? ` #${a.entity_id}` : ''}</span>}
                      {a.target_role && <span> · Team: {a.target_role}</span>}
                    </div>
                  )}
                </div>
                {!a.is_read && <button onClick={() => markRead(a.id)} className="btn btn-ghost text-xs py-1.5">Mark read</button>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}