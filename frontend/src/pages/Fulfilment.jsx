import { useEffect, useState } from 'react'
import { RefreshCw, Play, CheckCircle2, Wrench, ShoppingCart, AlertTriangle, GitBranch, Factory, ClipboardCheck } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard } from '../components/ui'
import { fmtNum } from '../lib/format'

const STATUS_META = {
  READY_FOR_DISPATCH: { label: 'Ready for Dispatch', cls: 'bg-green-100 text-green-700', icon: CheckCircle2 },
  PRODUCTION_REQUIRED: { label: 'Production Required', cls: 'bg-blue-100 text-blue-700', icon: Wrench },
  PURCHASE_REQUIRED: { label: 'Purchase Required', cls: 'bg-amber-100 text-amber-700', icon: ShoppingCart },
  MANUAL_DECISION_REQUIRED: { label: 'Manual Decision Required', cls: 'bg-purple-100 text-purple-700', icon: AlertTriangle },
  FULFILLED: { label: 'Fulfilled', cls: 'bg-slate-100 text-slate-600', icon: CheckCircle2 },
  OVER_FULFILLED: { label: 'Over-fulfilled', cls: 'bg-red-100 text-red-700', icon: AlertTriangle },
}

const SRC_CLS = {
  TRADING: 'bg-cyan-100 text-cyan-700',
  MANUFACTURED: 'bg-blue-100 text-blue-700',
  MIXED: 'bg-violet-100 text-violet-700',
  UNKNOWN: 'bg-gray-100 text-gray-600',
}

export default function Fulfilment() {
  const [items, setItems] = useState([])
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const params = statusFilter ? { status: statusFilter } : {}
      const res = await api.get('/fulfilment', { params })
      setItems(res.data.items || [])
    } catch { setItems([]) } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [statusFilter])

  const sync = async () => {
    setSyncing(true)
    try {
      const r = await api.post('/fulfilment/sync-requirements')
      setMsg(`Sync complete — ${r.data.requirements_created} requirement(s) created, ${r.data.alerts_generated} alert(s) generated`)
      load()
    } catch (e) { setMsg('Sync failed: ' + (e.response?.data?.detail || e.message)) } finally { setSyncing(false) }
  }

  const recompute = async () => {
    setRecomputing(true)
    try {
      const r = await api.post('/fulfilment/recompute-status')
      setMsg(`Status recompute complete — ${r.data.changed} order(s) advanced, ${r.data.scanned} scanned`)
      load()
    } catch (e) { setMsg('Recompute failed: ' + (e.response?.data?.detail || e.message)) } finally { setRecomputing(false) }
  }

  const counts = items.reduce((acc, x) => { acc[x.fulfilment_status] = (acc[x.fulfilment_status] || 0) + 1; return acc }, {})
  const ready = counts.READY_FOR_DISPATCH || 0
  const over = counts.OVER_FULFILLED || 0

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Order Fulfilment" subtitle="Stock check → decision per order line (ready / production / purchase / manual)"
        actions={
          <>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={recompute} disabled={recomputing} className="btn btn-secondary"><GitBranch size={15} /> {recomputing ? 'Recomputing…' : 'Recompute Status'}</button>
            <button onClick={sync} disabled={syncing} className="btn btn-primary"><Play size={15} /> {syncing ? 'Syncing…' : 'Sync Requirements'}</button>
          </>
        } />

      {msg && <div className="mb-4 text-sm state-box bg-blue-50 border border-blue-200 text-blue-800">{msg}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Lines Scanned" value={items.length} icon={ClipboardCheck} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Ready to Dispatch" value={ready} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Over-fulfilled" value={over} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        <StatCard label="Data Sources" value={new Set(items.map((x) => x.source_type)).size} icon={Factory} iconClass="bg-blue-50 text-blue-600" />
      </div>

      <Card actions={
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input">
          <option value="">All statuses ({items.length})</option>
          {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label} ({counts[k] || 0})</option>)}
        </select>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th>Order / PO</th><th>Customer</th>
              <th>Product</th><th>Source</th>
              <th className="text-right">Ordered</th><th className="text-right">Balance</th>
              <th className="text-right">Stock</th><th className="text-right">Shortage</th>
              <th>Decision</th>
            </tr></thead>
            <tbody>
              {items.map((it) => {
                const M = STATUS_META[it.fulfilment_status] || { label: it.fulfilment_status, cls: 'bg-gray-100 text-gray-600', icon: AlertTriangle }
                return (
                  <tr key={it.sales_order_line_id}>
                    <td className="font-mono text-xs">{it.order_no}</td>
                    <td>{it.customer || '—'}</td>
                    <td className="!sticky left-0 bg-inherit font-medium">{it.product_name}</td>
                    <td><Badge className={SRC_CLS[it.source_type] || 'bg-gray-100 text-gray-600'}>{it.source_type}</Badge></td>
                    <td className="text-right">{fmtNum(it.ordered_qty)}</td>
                    <td className={`text-right ${it.balance < 0 ? 'text-red-600 font-semibold' : ''}`}>{it.balance < 0 ? <Badge className="bg-red-100 text-red-700" dot>OVER · {fmtNum(it.balance)}</Badge> : fmtNum(it.balance)}</td>
                    <td className="text-right">{fmtNum(it.available_stock)}</td>
                    <td className="text-right font-semibold text-red-600">{fmtNum(it.shortage_qty)}</td>
                    <td><Badge className={M.cls}>{M.label}</Badge></td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  )
}