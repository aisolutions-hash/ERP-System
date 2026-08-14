import { useEffect, useState } from 'react'
import { Download, Eye } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  Pending: 'bg-amber-100 text-amber-700',
  'In Transit': 'bg-cyan-100 text-cyan-700',
  'Partially Dispatched': 'bg-blue-100 text-blue-700',
  Completed: 'bg-green-100 text-green-700',
  Delivered: 'bg-green-100 text-green-700',
}

export default function Dispatch() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState(null)

  const load = () => {
    setLoading(true)
    api
      .get('/dispatch', { params: { status } })
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
    { key: 'dispatch_no', label: 'Dispatch No', render: (r) => <span className="font-medium">{r.dispatch_no}</span> },
    { key: 'customer', label: 'Customer / Plant', render: (r) => r.plant?.name || r.customer?.name || '—' },
    { key: 'sales_person', label: 'Sales Person', render: (r) => r.sales_person || '—' },
    { key: 'schedule', label: 'Schedule', render: (r) => fmtNum(r.schedule_qty) },
    { key: 'dispatched', label: 'Dispatched', render: (r) => <span className="font-semibold">{fmtNum(r.dispatched_qty)}</span> },
    { key: 'comp', label: '% Comp', render: (r) => r.completion_pct != null ? `${(r.completion_pct * 100).toFixed(1)}%` : '—' },
    { key: 'balance', label: 'Balance', render: (r) => fmtNum(r.balance_qty) },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status}</Badge> },
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
        title="Dispatch"
        subtitle="Dispatch schedule vs actual per customer plant"
        actions={
          <a href="/api/reports/dispatch/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
            <Download size={15} /> CSV
          </a>
        }
      />

      <Card
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="partial">Partially Dispatched</option>
            <option value="completed">Completed</option>
            <option value="delivered">Delivered</option>
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
        <Modal open title={`Dispatch ${detail.dispatch_no}`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Plant:</span> <span className="font-medium">{detail.plant?.name || '—'}</span></div>
            <div><span className="text-slate-500">Sales:</span> {detail.sales_person || '—'}</div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
            <div><span className="text-slate-500">Report Date:</span> {detail.report_date}</div>
          </div>
          <Table
            columns={[
              { key: 'product', label: 'Product', render: (l) => l.product?.model || l.description },
              { key: 'quantity', label: 'Qty', render: (l) => fmtNum(l.quantity) },
              { key: 'dispatch_date', label: 'Date' },
              { key: 'rate', label: 'Rate', render: (l) => l.rate != null ? fmtNum(l.rate) : '—' },
              { key: 'weight', label: 'Weight', render: (l) => l.weight != null ? fmtNum(l.weight) : '—' },
            ]}
            data={detail.lines || []}
          />
        </Modal>
      )}
    </div>
  )
}