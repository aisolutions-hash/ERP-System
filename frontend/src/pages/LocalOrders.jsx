import { useEffect, useState } from 'react'
import { Store, ClipboardList } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard } from '../components/ui'
import { StatusBadge } from '../lib/format'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

export default function LocalOrders() {
  const [rows, setRows] = useState([])
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/local-orders', { params: { page_size: 500 } })
      .then((res) => setRows(res.data.items || []))
      .catch(() => setRows([]))
    api.get('/local-orders/plans')
      .then((res) => setPlans(res.data.items || []))
      .catch(() => setPlans([]))
      .finally(() => setLoading(false))
  }, [])

  const orderCols = [
    { key: 'order_no', label: 'Order', render: (r) => <span className="font-mono text-xs font-medium">{r.order_no || '—'}</span> },
    { key: 'customer', label: 'Customer', render: (r) => <span className="font-medium">{r.customer || '—'}</span> },
    { key: 'order_date', label: 'Date', render: (r) => r.order_date || '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'commitment', label: 'Commitment', render: (r) => r.commitment || '—' },
    { key: 'dispatched_qty', label: 'Dispatched', render: (r) => fmtNum(r.dispatched_qty) },
    { key: 'lines', label: 'Line Items', render: (r) => <Badge className="bg-slate-100 text-slate-600">{(r.lines || []).length}</Badge> },
  ]

  const planCols = [
    { key: 'plan_type', label: 'Plan Type', render: (r) => <Badge className="bg-violet-100 text-violet-700">{r.plan_type || '—'}</Badge> },
    { key: 'model', label: 'Model', render: (r) => <span className="font-medium">{r.model || '—'}</span> },
    { key: 'customer', label: 'Customer', render: (r) => r.customer || '—' },
    { key: 'quantity', label: 'Quantity', render: (r) => fmtNum(r.quantity) },
    { key: 'owner', label: 'Owner', render: (r) => r.owner || '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'plan_date', label: 'Date', render: (r) => r.plan_date || '—' },
    { key: 'remarks', label: 'Remarks', render: (r) => r.remarks || '—' },
  ]

  const totalDispatched = rows.reduce((s, r) => s + (Number(r.dispatched_qty) || 0), 0)

  if (loading) return <Loading />
  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Local Orders" subtitle="Domestic/local sales, separated from OEM customer orders" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Local Orders" value={rows.length} icon={Store} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Plans" value={plans.length} icon={ClipboardList} iconClass="bg-violet-50 text-violet-600" />
        <StatCard label="Dispatched Qty" value={fmtNum(totalDispatched)} icon={Store} iconClass="bg-cyan-50 text-cyan-600" />
      </div>

      <Card title="Local Orders" className="mb-6">
        {rows.length === 0 ? <Empty text="No local orders" /> : <Table columns={orderCols} data={rows} keyField="id" stickyColumns={['order_no']} dense />}
      </Card>
      <Card title="Production / Dispatch Plans (Local)">
        {plans.length === 0 ? <Empty text="No plans" /> : <Table columns={planCols} data={plans} keyField="id" stickyColumns={['model']} dense />}
      </Card>
    </div>
  )
}