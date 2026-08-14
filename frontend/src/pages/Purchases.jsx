import { useEffect, useState } from 'react'
import { Plus, Search, Download, Eye } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  Draft: 'bg-gray-100 text-gray-600',
  Ordered: 'bg-cyan-100 text-cyan-700',
  'Partially Received': 'bg-amber-100 text-amber-700',
  Received: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}

export default function Purchases() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState(null)

  const load = () => {
    setLoading(true)
    api
      .get('/purchases', { params: { search } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [search])

  const columns = [
    { key: 'po_number', label: 'PO No', render: (r) => <span className="font-medium">{r.po_number}</span> },
    { key: 'supplier', label: 'Supplier', render: (r) => r.supplier?.name || '—' },
    { key: 'order_date', label: 'Order Date' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status}</Badge> },
    { key: 'total_amount', label: 'Total Amount', render: (r) => fmtNum(r.total_amount) },
    { key: 'lines', label: 'Lines', render: (r) => r.lines?.length || 0 },
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
        title="Purchases"
        subtitle="Purchase orders from the store sheet (PO NO)"
        actions={
          <>
            <a href="/api/reports/purchases/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
              <Download size={15} /> CSV
            </a>
            <button className="inline-flex items-center gap-1.5 text-sm bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800">
              <Plus size={15} /> New PO
            </button>
          </>
        }
      />

      <Card
        actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PO…"
              className="pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={columns} data={items} />
        )}
      </Card>

      {detail && (
        <Modal open title={`PO ${detail.po_number}`} onClose={() => setDetail(null)} wide>
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Supplier:</span> <span className="font-medium">{detail.supplier?.name || '—'}</span></div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
            <div><span className="text-slate-500">Order Date:</span> {detail.order_date}</div>
            <div><span className="text-slate-500">Total:</span> <span className="font-medium">{fmtNum(detail.total_amount)}</span></div>
          </div>
          <Table
            columns={[
              { key: 'product', label: 'Product', render: (l) => l.product?.model || l.description },
              { key: 'quantity', label: 'Qty', render: (l) => fmtNum(l.quantity) },
              { key: 'received_qty', label: 'Received', render: (l) => fmtNum(l.received_qty) },
              { key: 'rate', label: 'Rate', render: (l) => l.rate != null ? fmtNum(l.rate) : '—' },
              { key: 'amount', label: 'Amount', render: (l) => l.amount != null ? fmtNum(l.amount) : '—' },
            ]}
            data={detail.lines || []}
          />
        </Modal>
      )}
    </div>
  )
}