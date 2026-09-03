import { useEffect, useState } from 'react'
import { Clock, CheckCircle2, AlertTriangle, ShoppingBag } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, StatCard, PageTabs } from '../components/ui'
import { FlowBadge } from '../lib/format'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

export default function PendingPO() {
  const [mode, setMode] = useState('all')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = (m) => {
    setLoading(true)
    api.get('/orders/pending', { params: { mode: m, page_size: 500 } })
      .then((res) => setRows(res.data.items || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(mode) }, [mode])

  const summary = {
    pending: rows.filter((r) => r.status === 'Pending').length,
    completed: rows.filter((r) => r.status === 'Completed').length,
    over: rows.filter((r) => r.status === 'Over-fulfilled').length,
  }

  const cols = [
    { key: 'status', label: 'Status', render: (r) => <FlowBadge status={r.status} /> },
    { key: 'order_no', label: 'Order', render: (r) => <span className="font-mono text-xs font-medium">{r.order_no || '—'}</span> },
    { key: 'customer', label: 'Customer', render: (r) => <span className="font-medium">{r.customer || '—'}</span> },
    { key: 'customer_po_no', label: 'PO No', render: (r) => <span className="font-mono text-xs">{r.customer_po_no || '—'}</span> },
    { key: 'model', label: 'Description', render: (r) => r.model || r.description || '—' },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'ordered_qty', label: 'Order Qty', render: (r) => fmtNum(r.ordered_qty) },
    { key: 'dispatched_qty', label: 'Dispatched', render: (r) => fmtNum(r.dispatched_qty) },
    { key: 'balance_qty', label: 'Balance', render: (r) => r.balance_qty < 0 ? <BadgeRed v={r.balance_qty} /> : <span className={r.balance_qty === 0 ? 'text-green-600 font-semibold' : 'font-medium'}>{fmtNum(r.balance_qty)}</span> },
    { key: 'order_date', label: 'Order Date', render: (r) => r.order_date || '—' },
    { key: 'period', label: 'Period', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.period || '—'}</Badge> },
  ]

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Pending Purchase Orders" subtitle="Ordered vs dispatched, with over-fulfilment detection" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Pending" value={summary.pending} icon={Clock} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
        <StatCard label="Completed" value={summary.completed} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Over-fulfilled" value={summary.over} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
      </div>

      <PageTabs tabs={[
        { key: 'all', label: 'All', icon: <ShoppingBag size={15} />, count: rows.length },
        { key: 'current', label: 'Current Period', icon: <Clock size={15} /> },
      ]} active={mode} onChange={setMode} />

      <Card>
        {loading ? <Loading /> : rows.length === 0 ? <Empty text="No pending order rows" /> : <Table columns={cols} data={rows} keyField="id" stickyColumns={['order_no']} dense />}
      </Card>
    </div>
  )
}

function BadgeRed({ v }) {
  return <span className="badge bg-red-100 text-red-700"><span className="badge-dot" />OVER · {fmtNum(v)}</span>
}
function Badge({ children, className }) {
  return <span className={`badge ${className}`}>{children}</span>
}