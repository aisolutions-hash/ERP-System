import { useEffect, useState } from 'react'
import { Plus, Search, Download, Eye } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  Planned: 'bg-amber-100 text-amber-700',
  'In Production': 'bg-blue-100 text-blue-700',
  Completed: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}

export default function Production() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState(null)

  const load = () => {
    setLoading(true)
    api
      .get('/production', { params: { status } })
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
    { key: 'product', label: 'Product', render: (r) => r.product?.model || '—' },
    { key: 'schedule', label: 'Schedule', render: (r) => fmtNum(r.schedule_qty) },
    { key: 'produced', label: 'Produced', render: (r) => fmtNum(r.produced_qty) },
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
        title="Production"
        subtitle="Daily production output per finished good"
        actions={
          <>
            <a href="/api/reports/production/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
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
            <option value="planned">Planned</option>
            <option value="in_production">In Production</option>
            <option value="completed">Completed</option>
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
        <Modal open title={`Production ${detail.order_no}`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Product:</span> <span className="font-medium">{detail.product?.model}</span></div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
            <div><span className="text-slate-500">Report Date:</span> {detail.report_date}</div>
            <div><span className="text-slate-500">Schedule:</span> {fmtNum(detail.schedule_qty)}</div>
            <div><span className="text-slate-500">Produced:</span> {fmtNum(detail.produced_qty)}</div>
            <div><span className="text-slate-500">Balance:</span> {fmtNum(detail.balance_qty)}</div>
          </div>
          <Table
            columns={[
              { key: 'production_date', label: 'Date' },
              { key: 'quantity', label: 'Output', render: (m) => fmtNum(m.quantity) },
            ]}
            data={detail.movements || []}
          />
        </Modal>
      )}
    </div>
  )
}