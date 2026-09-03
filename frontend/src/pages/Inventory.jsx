import { useEffect, useState } from 'react'
import { Search, Download, Package, CheckCircle2, AlertTriangle } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  OK: 'bg-green-100 text-green-700',
  LOW: 'bg-amber-100 text-amber-700',
  OUT_OF_STOCK: 'bg-red-100 text-red-600',
}

export default function Inventory() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')

  const load = () => {
    setLoading(true)
    api.get('/inventory', { params: { search, category, status } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [search, category, status])

  const columns = [
    { key: 'model', label: 'Product', render: (r) => <span className="font-medium">{r.product?.model}</span> },
    { key: 'code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.product?.item_code || '—'}</span> },
    { key: 'cat', label: 'Category', render: (r) => <Badge className="bg-gray-100 text-gray-600">{r.product?.category?.replace(/_/g, ' ')}</Badge> },
    { key: 'plant', label: 'Location', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.plant?.name || 'Main Store'}</Badge> },
    { key: 'opening', label: 'Opening', render: (r) => fmtNum(r.opening_stock) },
    { key: 'received', label: 'Received', render: (r) => <span className="text-green-600">{fmtNum(r.received_qty)}</span> },
    { key: 'issued', label: 'Issued', render: (r) => <span className="text-red-600">{fmtNum(r.issued_qty)}</span> },
    { key: 'current', label: 'Current Stock', render: (r) => <span className="font-semibold">{fmtNum(r.current_stock)}</span> },
    { key: 'min', label: 'Min Level', render: (r) => r.min_level != null ? fmtNum(r.min_level) : '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status.replace('_', ' ')}</Badge> },
  ]

  const ok = items.filter((i) => i.status === 'OK').length
  const low = items.filter((i) => i.status === 'LOW').length
  const out = items.filter((i) => i.status === 'OUT_OF_STOCK').length
  const totalStock = items.reduce((s, i) => s + (Number(i.current_stock) || 0), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Inventory" subtitle="Stock levels by location with low-stock alerts"
        actions={<a href="/api/reports/inventory/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Stock Lines" value={items.length} icon={Package} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Healthy" value={ok} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Low Stock" value={low} icon={AlertTriangle} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
        <StatCard label="Out of Stock" value={out} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
      </div>

      <Card subtitle={`Total stock on hand: ${fmtNum(totalStock)}`} actions={
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product…" className="input input-icon sm:w-56" />
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="input">
            <option value="">All categories</option>
            <option value="raw_material">Raw Material</option>
            <option value="finished">Finished</option>
            <option value="store">Store</option>
            <option value="trading">Trading</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input">
            <option value="">All statuses</option>
            <option value="LOW">Low Stock</option>
            <option value="OUT_OF_STOCK">Out of Stock</option>
          </select>
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : <Table columns={columns} data={items} keyField="id" stickyColumns={['model']} dense />}
      </Card>
    </div>
  )
}