import { useEffect, useState } from 'react'
import { Search, Download } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge } from '../components/ui'
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
    api
      .get('/inventory', { params: { search, category, status } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [search, category, status])

  const columns = [
    { key: 'model', label: 'Product', render: (r) => <span className="font-medium">{r.product?.model}</span> },
    { key: 'code', label: 'Item Code', render: (r) => r.product?.item_code || '—' },
    { key: 'cat', label: 'Category', render: (r) => <Badge className="bg-gray-100 text-gray-600">{r.product?.category}</Badge> },
    { key: 'plant', label: 'Location', render: (r) => r.plant?.name || 'Main Store' },
    { key: 'opening', label: 'Opening', render: (r) => fmtNum(r.opening_stock) },
    { key: 'received', label: 'Received', render: (r) => fmtNum(r.received_qty) },
    { key: 'issued', label: 'Issued', render: (r) => fmtNum(r.issued_qty) },
    { key: 'current', label: 'Current Stock', render: (r) => <span className="font-semibold">{fmtNum(r.current_stock)}</span> },
    { key: 'min', label: 'Min Level', render: (r) => r.min_level != null ? fmtNum(r.min_level) : '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status.replace('_', ' ')}</Badge> },
  ]

  return (
    <div>
      <PageHeader
        title="Inventory"
        subtitle="Stock levels by location with low-stock alerts"
        actions={
          <a href="/api/reports/inventory/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
            <Download size={15} /> CSV
          </a>
        }
      />

      <Card
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search product…"
                className="pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="">All categories</option>
              <option value="raw_material">Raw Material</option>
              <option value="finished">Finished</option>
              <option value="store">Store</option>
              <option value="trading">Trading</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white">
              <option value="">All statuses</option>
              <option value="LOW">Low Stock</option>
              <option value="OUT_OF_STOCK">Out of Stock</option>
            </select>
          </div>
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
    </div>
  )
}