import { useEffect, useState } from 'react'
import { Download, RefreshCw, Users, Truck, ClipboardCheck, AlertTriangle } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard, StatusBadge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum, CompletionBar } from '../lib/format'

let rowSeq = 0

export default function Dispatch() {
  const [customers, setCustomers] = useState([])
  const [summary, setSummary] = useState([])
  const [selected, setSelected] = useState('')
  const [lines, setLines] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [products, setProducts] = useState([])
  const [saving, setSaving] = useState(null)
  const [msg, setMsg] = useState('')
  const [msgType, setMsgType] = useState('success')

  const loadCustomers = () => {
    api.get('/customers', { params: { page_size: 500 } }).then((res) => setCustomers(res.data.items || [])).catch(() => {})
  }

  const loadSummary = () => {
    api.get('/dispatch/summary').then((res) => setSummary(res.data.items || [])).catch(() => setSummary([]))
  }

  const selectCustomer = (id) => {
    setSelected(id)
    setStatus('')
    setLines([])
    if (!id) return
    setLoading(true)
    api.get(`/dispatch/by-customer/${id}`, { params: { page_size: 500 } })
      .then((res) => { setLines((res.data.items || []).map((r) => ({ ...r, _row: ++rowSeq }))); setTotal(res.data.total) })
      .catch(() => setLines([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadCustomers(); loadSummary() }, [])

  const saveQty = (row) => {
    if (row.line_id == null) { setMsg('Cannot save: line not editable'); setMsgType('error'); return }
    setSaving(row._row); setMsg(''); setMsgType('success')
    const payload = { product_id: row.product_id ?? null, description: row.description || '', quantity: Number(row.dispatch_qty), dispatch_date: row.dispatch_date }
    api.patch(`/dispatch/lines/${row.line_id}`, payload)
      .then(() => { setMsg('Saved — balance recalculated'); selectCustomer(selected); loadSummary() })
      .catch(() => { setMsg('Save failed — check backend log'); setMsgType('error') })
      .finally(() => setSaving(null))
  }

  const summaryCols = [
    { key: 'customer', label: 'Customer', render: (r) => <button onClick={() => selectCustomer(r.customer_id)} className="font-medium text-slate-700 hover:text-amber-700 hover:underline text-left">{r.customer || '—'}</button> },
    { key: 'count', label: 'Dispatches', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.count}</Badge> },
    { key: 'total_schedule', label: 'Schedule', render: (r) => fmtNum(r.total_schedule) },
    { key: 'total_dispatched', label: 'Dispatched', render: (r) => <span className="font-semibold">{fmtNum(r.total_dispatched)}</span> },
    { key: 'completion_pct', label: 'Completion', render: (r) => <div className="min-w-32"><CompletionBar value={r.completion_pct} /></div> },
    { key: 'total_balance', label: 'Balance', render: (r) => r.over_dispatched
      ? <Badge className="bg-red-100 text-red-700" dot>OVER-FULFILLED · {fmtNum(r.total_balance)}</Badge>
      : rslt(r.total_balance) },
  ]
  function rslt(v) { return <span className={v < 0 ? 'text-red-600 font-semibold' : 'font-medium'}>{fmtNum(v)}</span> }

  const lineCols = [
    { key: 'dispatch_date', label: 'Dispatch Date', render: (r) => r.dispatch_date || '—' },
    { key: 'customer_po_no', label: 'PO Number', render: (r) => <span className="font-mono text-xs">{r.customer_po_no || '—'}</span> },
    { key: 'model', label: 'Description / Model', render: (r) => <span className="font-medium">{r.model || r.description || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'schedule_qty', label: 'Schedule', render: (r) => fmtNum(r.schedule_qty) },
    { key: 'dispatch_qty', label: 'Dispatch Qty (edit)', render: (r) => (
      <input type="number" value={r.dispatch_qty}
        onChange={(e) => setLines((ls) => ls.map((x) => x._row === r._row ? { ...x, dispatch_qty: Number(e.target.value) } : x))}
        className="input w-24" />
    )},
    { key: 'balance_qty', label: 'Balance (auto)', render: (r) => r.balance_qty < 0
      ? <Badge className="bg-red-100 text-red-700" dot>OVER · {fmtNum(r.balance_qty)}</Badge>
      : rslt(r.balance_qty) },
    { key: 'sales_person', label: 'Salesperson', render: (r) => r.sales_person || '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'save', label: '', render: (r) => (
      <button onClick={() => saveQty(r)} disabled={saving === r._row} className="btn btn-primary text-xs py-1.5 px-3">
        {saving === r._row ? <span className="inline-flex items-center gap-1"><span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />Saving…</span> : 'Save'}
      </button>
    )},
  ]

  const selectedInfo = summary.find((s) => s.customer_id === Number(selected))
  const overDisp = (lines || []).filter((l) => l.balance_qty < 0)
  const totalSched = lines.reduce((s, l) => s + (Number(l.schedule_qty) || 0), 0)
  const totalDisp = lines.reduce((s, l) => s + (Number(l.dispatch_qty) || 0), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Dispatch — Customer-wise" subtitle="Select a customer, then edit dispatch quantities (balance is auto-recalculated)"
        actions={
          <>
            <button onClick={() => { loadSummary(); if (selected) selectCustomer(selected) }} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <a href="/api/reports/dispatch/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
          </>
        } />

      {/* Prominent customer selector */}
      <div className="card p-4 mb-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-600 shrink-0">
          <Users size={16} className="text-amber-500" /> Customer:
        </div>
        <select value={selected} onChange={(e) => selectCustomer(e.target.value)} className="input sm:max-w-md">
          <option value="">Select a customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {selectedInfo && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 ml-0 sm:ml-auto">
            <span><span className="font-semibold text-slate-700">{selectedInfo.total_dispatched}</span> dispatched</span>
            <span><span className="font-semibold text-slate-700">{(selectedInfo.completion_pct * 100).toFixed(1)}%</span> complete</span>
          </div>
        )}
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Customers" value={summary.length} icon={Users} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Total Dispatch Lines" value={summary.reduce((s, x) => s + (x.count || 0), 0)} icon={ClipboardCheck} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Over-fulfilled" value={summary.filter((s) => s.over_dispatched).length} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        <StatCard label="Dispatch Done" value={fmtNum(summary.reduce((s, x) => s + (x.total_dispatched || 0), 0))} icon={Truck} iconClass="bg-cyan-50 text-cyan-600" />
      </div>

      {/* Customer summary */}
      <Card title="Customer Dispatch Summary" subtitle="Click a customer to load dispatch detail">
        {summary.length === 0 ? <Empty text="No dispatch summary" /> : <Table columns={summaryCols} data={summary} keyField="customer_id" stickyColumns={['customer']} />}
      </Card>

      {selected && (
        <Card className="mt-6" title={selectedInfo?.customer || 'Dispatch Detail'} subtitle={`${total} dispatch line(s)`}>
          {msg && <div className={`mb-3 text-sm state-box ${msgType === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>{msg}</div>}
          {overDisp.length > 0 && (
            <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200 flex items-center gap-2">
              <AlertTriangle size={15} /> {overDisp.length} line(s) over-dispatched (negative balance preserved)
            </div>
          )}
          <div className="flex flex-wrap gap-4 mb-3 text-xs text-slate-500">
            <span>Scheduled: <span className="font-semibold text-slate-700">{fmtNum(totalSched)}</span></span>
            <span>Dispatched: <span className="font-semibold text-slate-700">{fmtNum(totalDisp)}</span></span>
          </div>
          {loading ? <Loading /> : lines.length === 0 ? <Empty /> : (
            <Table columns={lineCols} data={lines} keyField="_row" stickyColumns={['model']} dense />
          )}
        </Card>
      )}
    </div>
  )
}