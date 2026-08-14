import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Search, Download } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

export default function RawMaterials() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)

  const load = () => {
    setLoading(true)
    api
      .get('/raw-materials')
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
    { key: 'item_code', label: 'Item Code', render: (r) => r.item_code || '—' },
    { key: 'model', label: 'Material', render: (r) => <span className="font-medium">{r.model}</span> },
    { key: 'schedule', label: 'Schedule', render: (r) => fmtNum(r.balance?.schedule_qty) },
    { key: 'inward', label: 'Inward Qty', render: (r) => fmtNum(r.balance?.inward_qty) },
    { key: 'comp', label: '% Comp', render: (r) => r.balance?.completion_pct != null ? `${(r.balance.completion_pct * 100).toFixed(1)}%` : '—' },
    { key: 'balance', label: 'Balance', render: (r) => fmtNum(r.balance?.balance_qty) },
    { key: 'opening', label: 'Opening', render: (r) => fmtNum(r.balance?.opening_stock) },
    { key: 'stock', label: 'Current Stock', render: (r) => fmtNum(r.current_stock) },
  ]

  return (
    <div>
      <PageHeader
        title="Raw Materials"
        subtitle="Monthly polymer position (schedule, inward, balance)"
        actions={
          <>
            <a
              href="/api/reports/raw-materials/csv"
              className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50"
            >
              <Download size={15} /> CSV
            </a>
            <button
              onClick={() => setModal({})}
              className="inline-flex items-center gap-1.5 text-sm bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800"
            >
              <Plus size={15} /> Add Material
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
              placeholder="Search material…"
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

      {modal && (
        <Modal open title="Add Raw Material Balance" onClose={() => setModal(null)}>
          <div className="text-sm text-slate-500">
            Material balance entries are created automatically by the data migration. Manual additions are supported via the API.
          </div>
        </Modal>
      )}
    </div>
  )
}