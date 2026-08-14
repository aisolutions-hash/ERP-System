import { useEffect, useState } from 'react'
import { Plus, Download, Eye } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  New: 'bg-amber-100 text-amber-700',
  Confirmed: 'bg-blue-100 text-blue-700',
  'In Production': 'bg-violet-100 text-violet-700',
  Ready: 'bg-teal-100 text-teal-700',
  Dispatched: 'bg-cyan-100 text-cyan-700',
  Completed: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}

export default function Orders() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState(null)

  const load = () => {
    setLoading(true)
    api
      .get('/orders', { params: { status } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [status])

  const columns = [
    { key: 'order_no', label: 'Order No', render: (r) => <span className="font-medium">{r.order_no}</span> },
    { key: 'customer', label: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'order_date', label: 'Order Date' },
    { key: 'required_delivery_date', label: 'Required Delivery', render: (r) => r.required_delivery_date || '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status}</Badge> },
    { key: 'total_value', label: 'Total Value', render: (r) => fmtNum(r.total_value) },
    { key: 'dispatch_qty', label: 'Dispatched', render: (r) => fmtNum(r.dispatch_qty) },
    {
      key: 'actions', label: '',
      render: (r) => (
        <button onClick={() => setDetail(r)} className="text-slate-400 hover:text-slate-700">
          <Eye size={16} />
        </button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Sales orders from the ORDER sheet and new entries"
        actions={
          <>
            <a href="/api/reports/orders/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
              <Download size={15} /> CSV
            </a>
            <button className="inline-flex items-center gap-1.5 text-sm bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800">
              <Plus size={15} /> New Order
            </button>
          </>
        }
      />

      <Card
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="confirmed">Confirmed</option>
            <option value="in_production">In Production</option>
            <option value="ready">Ready</option>
            <option value="dispatched">Dispatched</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        }
      >
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={columns} data={items} keyField="id" />
        )}
      </Card>

      {detail && (
        <Modal open title={`Order ${detail.order_no}`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{detail.customer?.name || '—'}</span></div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
            <div><span className="text-slate-500">Order Date:</span> {detail.order_date}</div>
            <div><span className="text-slate-500">Value:</span> <span className="font-medium">{fmtNum(detail.total_value)}</span></div>
          </div>
          <Table
            columns={[
              { key: 'product', label: 'Product', render: (l) => l.product?.model || l.description },
              { key: 'quantity', label: 'Qty', render: (l) => fmtNum(l.quantity) },
              { key: 'unit_price', label: 'Unit Price', render: (l) => l.unit_price != null ? fmtNum(l.unit_price) : '—' },
              { key: 'amount', label: 'Amount', render: (l) => l.amount != null ? fmtNum(l.amount) : '—' },
            ]}
            data={detail.lines || []}
          />
        </Modal>
      )}
    </div>
  )
}