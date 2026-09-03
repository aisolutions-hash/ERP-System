import { useEffect, useState } from 'react'
import { RefreshCw, Package, ClipboardList, AlertTriangle } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const catCls = {
  PURCHASE: 'bg-sky-100 text-sky-700',
  PRODUCTION: 'bg-violet-100 text-violet-700',
  DECISION: 'bg-amber-100 text-amber-700',
}
const statusCls = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Progress': 'bg-cyan-100 text-cyan-700',
  Ordered: 'bg-blue-100 text-blue-700',
  Received: 'bg-green-100 text-green-700',
  Completed: 'bg-green-100 text-green-700',
}

const STATUSES = ['Pending', 'In Progress', 'Ordered', 'Received', 'Completed']
const CATEGORIES = [['', 'All'], ['PURCHASE', 'PURCHASE'], ['PRODUCTION', 'PRODUCTION'], ['DECISION', 'DECISION']]

export default function Requirements() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [shortageOnly, setShortageOnly] = useState(true)

  const load = () => {
    setLoading(true)
    api.get('/requirements', { params: { category, shortage_only: shortageOnly, status: '', page_size: 500 } })
      .then((res) => { setRows(res.data.items || []); setTotal(res.data.total) })
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [category, shortageOnly])

  const patch = (lineId, fields) => {
    api.patch(`/requirements/${lineId}`, null, { params: fields }).then(load).catch(() => load())
  }

  const cols = [
    { key: 'category', label: 'Category', render: (r) => <Badge className={catCls[r.category] || 'bg-gray-100 text-gray-600'}>{r.category}</Badge> },
    { key: 'model', label: 'Model / Description', render: (r) => <span className="font-medium">{r.model || r.description || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'family', label: 'Family', render: (r) => r.family || '—' },
    { key: 'customer', label: 'Customer', render: (r) => r.customer || '—' },
    { key: 'order_no', label: 'Order', render: (r) => <span className="font-mono text-xs">{r.order_no || '—'}</span> },
    { key: 'customer_po_no', label: 'PO No', render: (r) => <span className="font-mono text-xs">{r.customer_po_no || '—'}</span> },
    { key: 'required_qty', label: 'Required', render: (r) => fmtNum(r.required_qty) },
    { key: 'available_qty', label: 'Available', render: (r) => fmtNum(r.available_qty) },
    { key: 'shortage_qty', label: 'Shortage', render: (r) => <span className="font-semibold text-red-600">{fmtNum(r.shortage_qty)}</span> },
    { key: 'status', label: 'Status', render: (r) => (
      <div className="flex items-center gap-1.5">
        <Badge className={statusCls[r.status] || 'bg-gray-100 text-gray-600'}>{r.status}</Badge>
        <select value={r.status} onChange={(e) => patch(r.line_id, { status: e.target.value })} className="input text-xs py-1 px-1.5 w-28">
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    )},
  ]

  const PURCHASE = rows.filter((r) => r.category === 'PURCHASE').length
  const PRODUCTION = rows.filter((r) => r.category === 'PRODUCTION').length
  const DECISION = rows.filter((r) => r.category === 'DECISION').length
  const totalShortage = rows.reduce((s, r) => s + (Number(r.shortage_qty) || 0), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Purchase / Production Requirements" subtitle="Shortage = required order balance − available stock (live)" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total Rows" value={total} icon={ClipboardList} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="PURCHASE" value={PURCHASE} icon={Package} iconClass="bg-sky-50 text-sky-600" />
        <StatCard label="PRODUCTION" value={PRODUCTION} icon={Package} iconClass="bg-violet-50 text-violet-600" />
        <StatCard label="Total Shortage" value={fmtNum(totalShortage)} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
      </div>

      <Card actions={
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-slate-600 select-none">
            <input type="checkbox" checked={shortageOnly} onChange={(e) => setShortageOnly(e.target.checked)} className="accent-amber-500" />
            Shortage only
          </label>
          <button onClick={load} className="btn btn-secondary"><RefreshCw size={14} /> Refresh</button>
        </div>
      }>
        <div className="flex gap-1 flex-wrap mb-4">
          {CATEGORIES.map(([v, l]) => (
            <button key={v} onClick={() => setCategory(v)}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium ${category === v ? 'bg-slate-900 text-white' : 'bg-gray-100 text-slate-600 hover:bg-gray-200'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="text-sm text-slate-500 mb-2">{total} requirement row(s)</div>
        {loading ? <Loading /> : rows.length === 0 ? <Empty text="No requirements" /> : <Table columns={cols} data={rows} keyField="id" stickyColumns={['model']} dense />}
      </Card>
    </div>
  )
}