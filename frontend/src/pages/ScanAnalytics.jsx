import { useEffect, useState } from 'react'
import { BarChart3, ScanLine, TrendingUp, Users, Package } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, AreaChart, Area,
} from 'recharts'
import api from '../lib/api'
import { PageHeader, Card, Loading, StatCard, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4']

export default function ScanAnalytics() {
  const [analytics, setAnalytics] = useState(null)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)

  const load = (d) => {
    setLoading(true)
    api.get('/barcodes/scan-events/analytics', { params: { days: d } })
      .then((r) => setAnalytics(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(days) }, [days])

  if (loading && !analytics) return <Loading />
  if (!analytics) return null

  const peakDay = analytics.daily.reduce((m, d) => d.scans > (m?.scans || 0) ? d : m, null)

  const topProductCols = [
    { key: 'model', label: 'Product', render: (r) => r.model || `#${r.product_id}` },
    { key: 'item_code', label: 'Code', render: (r) => <span className="font-mono text-xs">{r.item_code}</span> },
    { key: 'barcode', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.barcode}</span> },
    { key: 'scans', label: 'Scans', render: (r) => <Badge className="bg-amber-100 text-amber-700">{r.scans}</Badge> },
    { key: 'qty', label: 'Qty moved', render: (r) => fmtNum(r.qty) },
  ]

  return (
    <div>
      <PageHeader title="Scan Analytics & Marketing Insights"
        subtitle="Demand signals + scanner activity across the last N days."
        actions={
          <>
            <select value={days} onChange={(e) => load(Number(e.target.value))} className="input !w-auto">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </select>
            <Badge className="bg-violet-100 text-violet-700">Phase 7</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total scans" value={fmtNum(analytics.total_scans)} icon={ScanLine} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Total qty moved" value={fmtNum(analytics.total_qty)} icon={Package} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Total weight (KG)" value={fmtNum(analytics.total_weight_kg)} icon={TrendingUp} iconClass="bg-violet-50 text-violet-600" />
        <StatCard label="Peak day" value={peakDay ? fmtNum(peakDay.scans) : 0} sub={peakDay?.date || '—'} icon={BarChart3} iconClass="bg-emerald-50 text-emerald-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title="Daily scan volume" subtitle="By date">
          {analytics.daily.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={analytics.daily}>
                <defs>
                  <linearGradient id="gScans" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Area type="monotone" dataKey="scans" stroke="#f59e0b" strokeWidth={2} fill="url(#gScans)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Scan breakdown" subtitle="By event type">
          {analytics.by_type.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={analytics.by_type} dataKey="v" nameKey="k" cx="50%" cy="50%" innerRadius={48} outerRadius={76} paddingAngle={2}>
                  {analytics.by_type.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title="Device mix" subtitle="USB HID vs camera vs manual">
          {analytics.by_device.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={analytics.by_device}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="k" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="v" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Top scanned products (demand signal)">
          {analytics.top_products.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No data</div> : (
            <Table columns={topProductCols} data={analytics.top_products} keyField="product_id" dense stickyColumns={['model']} />
          )}
        </Card>
      </div>
    </div>
  )
}
