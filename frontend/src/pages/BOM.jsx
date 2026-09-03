import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Search, AlertTriangle, Boxes, CircuitBoard, Layers } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

export default function BOM() {
  const [items, setItems] = useState([])
  const [finished, setFinished] = useState([])
  const [rawMaterials, setRawMaterials] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ version: 1, is_active: true })
  const [validation, setValidation] = useState(null)

  const loadProducts = async () => {
    const [fin, rm] = await Promise.all([
      api.get('/products', { params: { category: 'finished', page_size: 500 } }),
      api.get('/products', { params: { category: 'raw_material', page_size: 500 } }),
    ])
    setFinished(fin.data.items || [])
    setRawMaterials(rm.data.items || [])
  }

  const load = async () => {
    setLoading(true)
    try {
      const params = { is_active: activeOnly }
      const res = await api.get('/bom', { params })
      setItems(res.data || [])
    } catch { setItems([]) } finally { setLoading(false) }
  }

  useEffect(() => { load(); loadProducts() }, [activeOnly])
  useEffect(() => { loadProducts() }, [])

  const filtered = items.filter((b) => !search || (b.product_name || '').toLowerCase().includes(search.toLowerCase()) || (b.raw_material_name || '').toLowerCase().includes(search.toLowerCase()))

  const save = async () => {
    const payload = {
      product_id: Number(form.product_id),
      raw_material_product_id: Number(form.raw_material_product_id),
      quantity_per_unit: Number(form.quantity_per_unit),
      uom: form.uom || 'KG',
      version: Number(form.version || 1),
      effective_date: form.effective_date || new Date().toISOString().slice(0, 10),
      notes: form.notes || '',
    }
    if (!payload.product_id || !payload.raw_material_product_id) { setValidation('Finished product and raw material are required'); return }
    if (payload.product_id === payload.raw_material_product_id) { setValidation('Finished product and raw material cannot be the same'); return }
    if (!(payload.quantity_per_unit > 0)) { setValidation('Quantity per unit must be > 0'); return }
    try {
      if (form.id) await api.put(`/bom/${form.id}`, payload)
      else await api.post('/bom', payload)
      setValidation(null); setShowForm(false); setForm({}); await load()
    } catch (e) {
      setValidation(e.response?.data?.detail || 'Save failed')
    }
  }

  const columns = [
    { key: 'product_name', label: 'Finished Product', render: (r) => <span className="font-medium">{r.product_name}</span> },
    { key: 'raw_material_name', label: 'Raw Material', render: (r) => <span>{r.raw_material_name}</span> },
    { key: 'quantity_per_unit', label: 'Qty per Unit', render: (r) => <Badge className="bg-slate-100 text-slate-700">{fmtNum(r.quantity_per_unit)} {r.uom}</Badge> },
    { key: 'version', label: 'Version', render: (r) => <Badge className="bg-slate-100 text-slate-600">v{r.version}</Badge> },
    { key: 'effective_date', label: 'Effective Date' },
    { key: 'is_active', label: 'Status', render: (r) => r.is_active ? <Badge className="bg-green-100 text-green-700">Active</Badge> : <Badge className="bg-gray-100 text-gray-500">Inactive</Badge> },
    { key: 'notes', label: 'Notes', render: (r) => r.notes || '—' },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => { setForm({ id: r.id, product_id: r.product_id, raw_material_product_id: r.raw_material_product_id, quantity_per_unit: r.quantity_per_unit, uom: r.uom, version: r.version, effective_date: r.effective_date, notes: r.notes, is_active: r.is_active }); setValidation(null); setShowForm(true) }} className="btn btn-ghost p-1.5"><Pencil size={15} /></button>
          <button onClick={async () => { if (confirm('Deactivate this BOM line?')) { await api.delete(`/bom/${r.id}`); load() } }} className="btn btn-ghost p-1.5 text-red-400"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const distinctProducts = new Set(items.map((r) => r.product_id)).size
  const activeCount = items.filter((r) => r.is_active).length

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Bill of Materials" subtitle="Finished product to raw material recipe (user-entered quantities)"
        actions={
          <>
            <div className="mr-2 inline-flex items-center gap-1 text-amber-600 text-xs"><AlertTriangle size={14} /> Do not invent quantities — enter actual BOM values</div>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={() => { setForm({ version: 1, is_active: true }); setValidation(null); setShowForm(true) }} className="btn btn-primary"><Plus size={15} /> New BOM</button>
          </>
        } />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="BOM Lines" value={items.length} icon={Layers} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Products Configured" value={distinctProducts} icon={Boxes} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Active Lines" value={activeCount} icon={CircuitBoard} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
      </div>

      <Card actions={
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-amber-500" /> Active only
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product / RM…" className="input input-icon sm:w-56" />
          </div>
        </div>
      }>
        {loading ? <Loading /> : filtered.length === 0 ? <Empty text={activeOnly ? 'No active BOM lines — create one to define material recipes' : 'No BOM lines found'} /> : <Table columns={columns} data={filtered} keyField="id" stickyColumns={['product_name']} dense />}
      </Card>

      <Modal open={showForm} title={form.id ? 'Edit BOM Line' : 'New BOM Line'} onClose={() => setShowForm(false)} wide
        footer={<>
          <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={save} className="btn btn-primary">Save BOM</button>
        </>}>
        {validation && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{validation}</div>}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Finished Product *</label>
            <select value={form.product_id ?? ''} onChange={(e) => setForm({ ...form, product_id: e.target.value ? Number(e.target.value) : '' })} className="input">
              <option value="">Select finished product…</option>
              {finished.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
            </select></div>
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Raw Material *</label>
            <select value={form.raw_material_product_id ?? ''} onChange={(e) => setForm({ ...form, raw_material_product_id: e.target.value ? Number(e.target.value) : '' })} className="input">
              <option value="">Select raw material…</option>
              {rawMaterials.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Qty per Unit *</label>
            <input type="number" step="any" value={form.quantity_per_unit ?? ''} onChange={(e) => setForm({ ...form, quantity_per_unit: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">UOM *</label>
            <select value={form.uom || 'KG'} onChange={(e) => setForm({ ...form, uom: e.target.value })} className="input">
              <option>KG</option><option>GM</option><option>LTR</option><option>Each</option><option>Roll</option>
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Version</label>
            <input type="number" value={form.version || 1} onChange={(e) => setForm({ ...form, version: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Effective Date</label>
            <input type="date" value={form.effective_date || ''} onChange={(e) => setForm({ ...form, effective_date: e.target.value })} className="input" /></div>
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Notes</label>
            <textarea value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" rows={2} /></div>
        </div>
      </Modal>
    </div>
  )
}