import { useEffect, useState } from 'react'
import { Plus, Pencil, Search, Download, RefreshCw, AlertTriangle, CheckCircle2, Boxes } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

export default function RawMaterials() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({})
  const [err, setErr] = useState(null)

  const load = () => {
    setLoading(true)
    api.get('/raw-materials', { params: { search } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [search])

  const openNew = () => {
    setForm({ report_date: new Date().toISOString().slice(0, 10) })
    setErr(null)
    setModal('new')
  }
  const openEdit = (item) => {
    setForm({
      product_id: item.id, report_date: new Date().toISOString().slice(0, 10),
      schedule_qty: item.balance?.schedule_qty ?? '', ask_till_date: item.balance?.ask_till_date ?? '',
      inward_qty: item.balance?.inward_qty ?? '', completion_pct: item.balance?.completion_pct ?? '',
      balance_qty: item.balance?.balance_qty ?? '', opening_stock: item.balance?.opening_stock ?? '',
    })
    setErr(null)
    setModal('edit')
  }
  const saveBalance = async () => {
    try {
      const params = { product_id: Number(form.product_id), report_date: form.report_date }
      for (const k of ['schedule_qty', 'ask_till_date', 'inward_qty', 'completion_pct', 'balance_qty', 'opening_stock']) {
        if (form[k] !== '' && form[k] != null) params[k] = Number(form[k])
      }
      await api.post('/raw-materials/balances', null, { params })
      setModal(null); setErr(null); load()
    } catch (e) { setErr(e.response?.data?.detail || 'Save failed') }
  }

  const columns = [
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'model', label: 'Material', render: (r) => <span className="font-medium">{r.model}</span> },
    { key: 'schedule', label: 'Schedule', render: (r) => fmtNum(r.balance?.schedule_qty) },
    { key: 'inward', label: 'Inward Qty', render: (r) => fmtNum(r.balance?.inward_qty) },
    { key: 'stock', label: 'Current Stock', render: (r) => <span className="font-semibold">{fmtNum(r.current_stock)}</span> },
    { key: 'usage', label: 'Usage', render: () => <span className="badge bg-slate-100 text-slate-400">Not tracked</span> },
    { key: 'comp', label: '% Comp', render: (r) => r.balance?.completion_pct != null ? `${(r.balance.completion_pct * 100).toFixed(1)}%` : '—' },
    {
      key: 'actions', label: '',
      render: (r) => (
        <button onClick={() => openEdit(r)} className="btn btn-ghost py-1 px-2 text-xs"><Pencil size={14} /> Edit</button>
      ),
    },
  ]

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Raw Materials" subtitle="Monthly polymer position • Consumption data not available for historical periods"
        actions={
          <>
            <a href="/api/reports/raw-materials/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> Update Balance</button>
          </>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Materials Tracked" value={items.length} icon={Boxes} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="In-Stock" value={items.filter((r) => Number(r.current_stock) > 0).length} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" />
        <StatCard label="Under-stocked" value={items.filter((r) => (r.balance?.balance_qty ?? 0) < 0).length} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        <StatCard label="Total Stock" value={fmtNum(items.reduce((s, r) => s + (Number(r.current_stock) || 0), 0))} icon={Boxes} iconClass="bg-cyan-50 text-cyan-600" />
      </div>

      <Card actions={
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search material…" className="input input-icon sm:w-64" />
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : <Table columns={columns} data={items} stickyColumns={['model']} />}
      </Card>

      <Modal open={!!modal} title={modal === 'edit' ? 'Edit Raw Material Balance' : 'Update Raw Material Balance'} onClose={() => setModal(null)}>
        {err && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{err}</div>}
        <div className="text-sm space-y-1 mb-3 text-slate-500">
          <div><span className="font-medium text-slate-700">{modal === 'edit' ? items.find((i) => i.id === form.product_id)?.model : 'Raw Material'}</span></div>
          <div className="text-xs">Storage / consumption is tracked via raw material balances + stock movements.</div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><label className="block text-slate-500 text-xs mb-1">Report Date</label>
            <input type="date" value={form.report_date || ''} onChange={(e) => setForm({ ...form, report_date: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Schedule Qty</label>
            <input type="number" step="any" value={form.schedule_qty ?? ''} onChange={(e) => setForm({ ...form, schedule_qty: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Inward Qty</label>
            <input type="number" step="any" value={form.inward_qty ?? ''} onChange={(e) => setForm({ ...form, inward_qty: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Balance Qty</label>
            <input type="number" step="any" value={form.balance_qty ?? ''} onChange={(e) => setForm({ ...form, balance_qty: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Opening Stock</label>
            <input type="number" step="any" value={form.opening_stock ?? ''} onChange={(e) => setForm({ ...form, opening_stock: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Completion % (0-1)</label>
            <input type="number" step="any" value={form.completion_pct ?? ''} onChange={(e) => setForm({ ...form, completion_pct: e.target.value })} className="input" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
          <button onClick={saveBalance} className="btn btn-primary">Save Balance</button>
        </div>
      </Modal>
    </div>
  )
}