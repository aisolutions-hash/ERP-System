import { useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, RefreshCw, Search, AlertTriangle, Boxes, Layers, X } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard, SearchSelect } from '../components/ui'
import Table from '../components/Table'

const UOM_SUGGESTIONS = ['KG', 'GM', 'LTR', 'ML', 'Each', 'Roll', 'Metre', 'Piece']

const today = () => new Date().toISOString().slice(0, 10)

export default function BOM() {
  const [items, setItems] = useState([])
  const [finished, setFinished] = useState([])
  const [rawMaterials, setRawMaterials] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(null)
  const [validation, setValidation] = useState('')
  const lineKeyRef = useRef(0)

  const nextKey = () => ++lineKeyRef.current

  const newLine = () => ({
    key: nextKey(), id: null, raw_material_product_id: null,
    raw_material_name: '', quantity_per_unit: '', uom: 'KG',
  })

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
      const res = await api.get('/bom/groups', { params: { is_active: activeOnly } })
      setItems(res.data || [])
    } catch { setItems([]) } finally { setLoading(false) }
  }

  useEffect(() => { load(); loadProducts() }, [activeOnly])
  useEffect(() => { loadProducts() }, [])

  const filtered = items.filter((b) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (b.bom_code || '').toLowerCase().includes(q)
      || (b.product_name || '').toLowerCase().includes(q)
      || ((b.lines || []).some((l) => (l.raw_material_name || '').toLowerCase().includes(q)))
  })

  const openNew = () => {
    setForm({
      id: null, bom_code: '', product_id: null, product_name: '', effective_date: today(),
      version: 1, notes: '', is_active: true, lines: [newLine()],
    })
    setValidation('')
    setShowForm(true)
  }

  const openEdit = (g) => {
    const lines = (g.lines || []).map((l) => ({
      key: nextKey(), id: l.id, raw_material_product_id: l.raw_material_product_id,
      raw_material_name: l.raw_material_name || '', quantity_per_unit: l.quantity_per_unit, uom: l.uom || 'KG',
    }))
    const isLegacy = g.id == null
    setForm({
      id: isLegacy ? null : g.id,
      bom_code: g.bom_code || '',
      product_id: g.product_id,
      product_name: isLegacy ? (g.product_name || '') : '',
      effective_date: g.effective_date || today(),
      version: g.version || 1,
      notes: g.notes || '',
      is_active: g.is_active,
      lines: lines.length ? lines : [newLine()],
    })
    setValidation('')
    setShowForm(true)
  }

  const updateLine = (key, patch) => setForm((f) => ({
    ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
  }))

  const removeLine = (key) => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }))

  const save = async () => {
    const f = form
    if (!f) return
    const code = (f.bom_code || '').trim()
    const productId = f.product_id ? Number(f.product_id) : null
    const lines = f.lines || []
    if (!productId && !(f.product_name || '').trim()) { setValidation('Select or type a finished product'); return }
    if (lines.length === 0) { setValidation('Add at least one raw material line'); return }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.raw_material_product_id && !(l.raw_material_name || '').trim()) { setValidation(`Raw material line ${i + 1}: select or type a raw material`); return }
      if (!(Number(l.quantity_per_unit) > 0)) { setValidation(`Raw material line ${i + 1}: quantity must be > 0`); return }
    }
    setValidation('')
    const legacyLineId = (f.id == null && lines.length === 1 && lines[0].id) ? lines[0].id : null
    try {
      if (legacyLineId && !code && productId && lines[0].raw_material_product_id) {
        // Historical single-line BOM without a code — keep old behaviour.
        await api.put(`/bom/${legacyLineId}`, {
          product_id: productId,
          raw_material_product_id: Number(lines[0].raw_material_product_id),
          quantity_per_unit: Number(lines[0].quantity_per_unit),
          uom: lines[0].uom || 'KG',
          version: Number(f.version || 1),
          effective_date: f.effective_date || today(),
          notes: f.notes || '',
          is_active: f.is_active,
        })
      } else {
        if (!code) { setValidation('BOM Code is required'); return }
        const payload = {
          bom_code: code,
          product_id: productId,
          product_name: productId ? '' : (f.product_name || '').trim(),
          effective_date: f.effective_date || today(),
          version: Number(f.version || 1),
          notes: f.notes || '',
          is_active: f.is_active,
          lines: lines.map((l) => ({
            id: l.id || null,
            raw_material_product_id: l.raw_material_product_id ? Number(l.raw_material_product_id) : null,
            raw_material_name: l.raw_material_product_id ? '' : (l.raw_material_name || '').trim(),
            quantity_per_unit: Number(l.quantity_per_unit),
            uom: (l.uom || 'KG').trim(),
          })),
        }
        if (f.id) await api.put(`/bom/groups/${f.id}`, payload)
        else await api.post('/bom/groups', payload)
      }
      setShowForm(false)
      await Promise.all([load(), loadProducts()])
    } catch (e) {
      setValidation(e.response?.data?.detail || 'Save failed')
    }
  }

  const deactivate = async (g) => {
    if (!confirm(g.bom_code
      ? `Deactivate BOM ${g.bom_code}?`
      : 'Deactivate this BOM line?')) return
    try {
      if (g.id) await api.delete(`/bom/groups/${g.id}`)
      else if (g.lines?.[0]?.id) await api.delete(`/bom/${g.lines[0].id}`)
      load()
    } catch (e) {
      alert('Deactivate failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  const columns = [
    { key: 'bom_code', label: 'BOM Code', render: (r) => r.bom_code
        ? <span className="font-mono text-xs font-semibold text-amber-700">{r.bom_code}</span>
        : <span className="text-slate-400">—</span> },
    { key: 'product_name', label: 'Finished Product', render: (r) => <span className="font-medium">{r.product_name}</span> },
    {
      key: 'lines', label: 'Raw Materials', render: (r) => (
        <div className="flex items-center gap-2">
          <Badge className="bg-slate-800 text-white">{r.lines?.length || 0}</Badge>
          <span className="text-xs text-slate-600 truncate max-w-[260px]">
            {(r.lines || []).map((l) => l.raw_material_name).join(', ')}
          </span>
        </div>
      ),
    },
    { key: 'version', label: 'Version', render: (r) => <Badge className="bg-slate-100 text-slate-600">v{r.version}</Badge> },
    { key: 'effective_date', label: 'Effective Date' },
    { key: 'is_active', label: 'Status', render: (r) => r.is_active ? <Badge className="bg-green-100 text-green-700">Active</Badge> : <Badge className="bg-gray-100 text-gray-500">Inactive</Badge> },
    { key: 'notes', label: 'Notes', render: (r) => r.notes || '—' },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => openEdit(r)} className="btn btn-ghost p-1.5" title="Edit BOM"><Pencil size={15} /></button>
          <button onClick={() => deactivate(r)} className="btn btn-ghost p-1.5 text-red-400" title="Deactivate"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const distinctProducts = new Set(items.map((r) => r.product_id)).size
  const activeCount = items.filter((r) => r.is_active).length
  const isLegacy = form && form.id == null && !form.bom_code && form.lines?.length === 1 && form.lines[0].id

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Bill of Materials" subtitle="Finished product to raw material recipe — one BOM Code, multiple raw material lines"
        actions={
          <>
            <div className="mr-2 inline-flex items-center gap-1 text-amber-600 text-xs"><AlertTriangle size={14} /> Do not invent quantities — enter actual BOM values</div>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> New BOM</button>
          </>
        } />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="BOMs" value={items.length} icon={Layers} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Products Configured" value={distinctProducts} icon={Boxes} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Active BOMs" value={activeCount} icon={Boxes} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
      </div>

      <Card actions={
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="accent-amber-500" /> Active only
          </label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code / product / RM…" className="input input-icon sm:w-64" />
          </div>
        </div>
      }>
        {loading ? <Loading /> : filtered.length === 0 ? <Empty text={activeOnly ? 'No active BOMs — create one to define a recipe with multiple raw materials' : 'No BOMs found'} /> : <Table columns={columns} data={filtered} keyField="id" onRowClick={openEdit} stickyColumns={['product_name']} dense />}
      </Card>

      <Modal open={!!showForm} title={form && form.id ? `Edit BOM — ${form.bom_code}` : (form && isLegacy ? 'Edit Legacy BOM Line' : 'New BOM')} onClose={() => setShowForm(false)} wide
        footer={<>
          <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={save} className="btn btn-primary">Save BOM</button>
        </>}>
        {validation && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{validation}</div>}
        {form && (
          <div className="text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-slate-500 text-xs mb-1">BOM Code * <span className="text-slate-400 font-normal">(must be unique)</span></label>
                <input value={form.bom_code || ''} onChange={(e) => setForm((f) => ({ ...f, bom_code: e.target.value }))}
                  placeholder="e.g. BOM-001" className="input" />
                {isLegacy && <p className="text-[0.6875rem] text-slate-400 mt-1">Legacy line — enter a code to upgrade it into a BOM, or leave empty to save as-is.</p>}
              </div>
              <div>
                <label className="block text-slate-500 text-xs mb-1">Finished Product * <span className="text-slate-400 font-normal">(type to search or enter a name)</span></label>
                <SearchSelect
                  options={finished.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                  value={form.product_id ?? null}
                  initialLabel={!form.product_id ? (form.product_name || '') : ''}
                  placeholder="Search / enter finished product…"
                  onChange={(id, manual) => setForm((f) => ({ ...f, product_id: id || null, product_name: id ? '' : (manual || f.product_name) }))}
                />
              </div>
              <div>
                <label className="block text-slate-500 text-xs mb-1">Version</label>
                <input type="number" value={form.version || 1} onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="block text-slate-500 text-xs mb-1">Effective Date</label>
                <input type="date" value={form.effective_date || ''} onChange={(e) => setForm((f) => ({ ...f, effective_date: e.target.value }))} className="input" />
              </div>
              <div className="col-span-2">
                <label className="block text-slate-500 text-xs mb-1">Notes</label>
                <textarea value={form.notes || ''} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} className="input" rows={2} />
              </div>
              <div className="col-span-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} className="accent-amber-500" /> Active BOM
                </label>
              </div>
            </div>

            <div className="border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-slate-700">Raw Materials</span>
                <button onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, newLine()] }))} className="btn btn-secondary text-xs py-1.5"><Plus size={13} /> Add Raw Material</button>
              </div>
              <datalist id="bom-uom-list">
                {UOM_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
              </datalist>
              {(form.lines || []).map((l) => (
                <div key={l.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-2 p-3 rounded-lg bg-slate-50/70 border border-gray-100">
                  <div className="sm:col-span-6">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Raw Material / Child Material * <span className="text-slate-400 font-normal">(type to search or enter a name)</span></label>
                    <SearchSelect
                      options={rawMaterials.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                      value={l.raw_material_product_id ?? null}
                      initialLabel={!l.raw_material_product_id ? (l.raw_material_name || '') : ''}
                      placeholder="Search / enter raw material…"
                      onChange={(id, manual) => updateLine(l.key, { raw_material_product_id: id || null, raw_material_name: id ? '' : (manual || l.raw_material_name) })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Quantity *</label>
                    <input type="number" min="0" step="any" value={l.quantity_per_unit ?? ''}
                      onChange={(e) => updateLine(l.key, { quantity_per_unit: e.target.value })}
                      placeholder="0" className="input py-1.5" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Unit *</label>
                    <input list="bom-uom-list" value={l.uom || ''}
                      onChange={(e) => updateLine(l.key, { uom: e.target.value })}
                      placeholder="KG" className="input py-1.5" />
                  </div>
                  <div className="sm:col-span-2 flex items-end justify-end pb-0.5">
                    <button onClick={() => removeLine(l.key)} className="text-red-400 hover:text-red-600 p-1.5 hover:bg-red-50 rounded" title="Remove raw material"><X size={14} /></button>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Raw materials: {(form.lines || []).length}</span>
                <span className="text-xs text-slate-400">{(form.lines || []).reduce((t, l) => t + (Number(l.quantity_per_unit) || 0), 0)} total qty</span>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}