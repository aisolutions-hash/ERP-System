import { useEffect, useState } from 'react'
import { Plus, Search, Download, Eye, Pencil, Trash2, RefreshCw, PackageOpen, FilePlus2, DollarSign, Layers, CheckCircle2 } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  Draft: 'bg-gray-100 text-gray-600',
  Ordered: 'bg-cyan-100 text-cyan-700',
  'Partially Received': 'bg-amber-100 text-amber-700',
  Received: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}
const statuses = ['Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled']

export default function Purchases() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [showReceive, setShowReceive] = useState(null)
  const [suppliers, setSuppliers] = useState([])
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ lines: [] })
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true)
    api.get('/purchases', { params: { search } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [search])
  useEffect(() => {
    api.get('/suppliers', { params: { page_size: 500 } }).then((r) => setSuppliers(r.data.items || [])).catch(() => {})
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || [])).catch(() => {})
  }, [])

  const nextPoNo = () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return `PO-${today}-${String(items.length + 1).padStart(3, '0')}`
  }

  const openNew = () => {
    setForm({ po_number: nextPoNo(), order_date: new Date().toISOString().slice(0, 10), status: 'Ordered', notes: '', lines: [{ product_id: '', description: '', quantity: '', received_qty: 0, rate: '', amount: '' }] })
    setError(null); setShowForm(true)
  }

  const openEdit = (po) => {
    setForm({
      id: po.id, po_number: po.po_number, supplier_id: po.supplier_id ?? '',
      order_date: po.order_date, status: po.status, notes: po.notes || '',
      lines: (po.lines || []).map((l) => ({ id: l.id, product_id: l.product_id ?? '', description: l.description || '', quantity: l.quantity, received_qty: l.received_qty || 0, rate: l.rate ?? '', amount: l.amount ?? '' })),
    })
    setError(null); setShowForm(true)
  }

  const setLine = (i, k, v) => {
    const lines = [...form.lines]
    lines[i] = { ...lines[i], [k]: v }
    if ((k === 'product_id' || k === 'quantity' || k === 'rate')) {
      const q = Number(lines[i].quantity || 0)
      const r = Number(lines[i].rate || 0)
      lines[i].amount = q * r
    }
    setForm({ ...form, lines })
  }

  const save = async () => {
    const payload = {
      po_number: form.po_number, supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
      order_date: form.order_date, status: form.status || 'Ordered', notes: form.notes || '',
      lines: form.lines.filter((l) => l.product_id || l.description).map((l) => ({
        product_id: l.product_id ? Number(l.product_id) : null,
        description: l.product_id ? '' : l.description,
        quantity: Number(l.quantity || 0), received_qty: Number(l.received_qty || 0),
        rate: l.rate !== '' && l.rate != null ? Number(l.rate) : null,
        amount: l.amount !== '' && l.amount != null ? Number(l.amount) : null,
      })),
    }
    if (!payload.po_number) { setError('PO number is required'); return }
    if (payload.lines.length === 0) { setError('Add at least one line'); return }
    try {
      if (form.id) await api.patch(`/purchases/${form.id}`, payload)
      else { const r = await api.post('/purchases', payload); setDetail(r.data) }
      setShowForm(false); setForm({ lines: [] }); setError(null); load()
    } catch (e) { setError(e.response?.data?.detail || 'Save failed') }
  }

  const del = async (po) => {
    if (!confirm(`Delete PO ${po.po_number}?`)) return
    try { await api.delete(`/purchases/${po.id}`); load() } catch (e) { alert('Delete failed: ' + (e.response?.data?.detail || e.message)) }
  }

  const columns = [
    { key: 'po_number', label: 'PO No', render: (r) => <span className="font-mono text-xs font-medium">{r.po_number}</span> },
    { key: 'supplier', label: 'Supplier', render: (r) => <span className="font-medium">{r.supplier?.name || '—'}</span> },
    { key: 'order_date', label: 'Order Date' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status}</Badge> },
    { key: 'total_amount', label: 'Total Amount', render: (r) => <span className="font-mono text-xs font-medium">{fmtNum(r.total_amount)}</span> },
    { key: 'lines', label: 'Lines', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.lines?.length || 0}</Badge> },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setDetail(r)} className="btn btn-ghost p-1.5" title="View"><Eye size={15} /></button>
          <button onClick={() => openEdit(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => setShowReceive(r)} className="btn btn-ghost p-1.5 text-green-600" title="Receive"><PackageOpen size={15} /></button>
          <button onClick={() => del(r)} className="btn btn-ghost p-1.5 text-red-400" title="Delete"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const received = items.filter((i) => i.status === 'Received').length
  const partial = items.filter((i) => i.status === 'Partially Received').length
  const partialOpen = items.filter((i) => ['Ordered', 'Partially Received'].includes(i.status))
  const openAmt = partialOpen.reduce((s, i) => s + (Number(i.total_amount) || 0), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Purchases" subtitle="Supplier purchase orders • Requirement → PO → Ordered → Partially Received → Received → Stock"
        actions={
          <>
            <a href="/api/reports/purchases/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> New PO</button>
          </>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Purchase Orders" value={items.length} icon={FilePlus2} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Received" value={received} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Partially Received" value={partial} icon={Layers} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
        <StatCard label="Open Value" value={fmtNum(openAmt)} icon={DollarSign} iconClass="bg-blue-50 text-blue-600" />
      </div>

      <Card actions={
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO…" className="input input-icon sm:w-56" />
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : <Table columns={columns} data={items} keyField="id" stickyColumns={['po_number']} />}
      </Card>

      {detail && (
        <Modal open title={`PO ${detail.po_number}`} onClose={() => setDetail(null)} wide
          footer={<button onClick={() => setDetail(null)} className="btn btn-secondary">Close</button>}>
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Supplier:</span> <span className="font-medium">{detail.supplier?.name || '—'}</span></div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
            <div><span className="text-slate-500">Order Date:</span> {detail.order_date}</div>
            <div><span className="text-slate-500">Total:</span> <span className="font-medium">{fmtNum(detail.total_amount)}</span></div>
            {detail.notes && <div className="col-span-2"><span className="text-slate-500">Notes:</span> {detail.notes}</div>}
          </div>
          <Table
            columns={[
              { key: 'product', label: 'Product', render: (l) => <span className="font-medium">{l.product?.model || l.description}</span> },
              { key: 'quantity', label: 'Qty', render: (l) => fmtNum(l.quantity) },
              { key: 'received_qty', label: 'Received', render: (l) => fmtNum(l.received_qty) },
              { key: 'pending', label: 'Pending', render: (l) => <span className={l.quantity - (l.received_qty || 0) > 0 ? 'text-amber-600' : 'text-green-600'}>{fmtNum((l.quantity || 0) - (l.received_qty || 0))}</span> },
              { key: 'rate', label: 'Rate', render: (l) => l.rate != null ? fmtNum(l.rate) : '—' },
              { key: 'amount', label: 'Amount', render: (l) => l.amount != null ? fmtNum(l.amount) : '—' },
            ]}
            data={detail.lines || []}
          />
        </Modal>
      )}

      {showReceive && (
        <ReceiveModal po={showReceive} onClose={() => setShowReceive(null)} onDone={() => { load() }} />
      )}

      {showForm && (
        <Modal open title={form.id ? `Edit PO ${form.po_number}` : 'New Purchase Order'} onClose={() => setShowForm(false)} wide
          footer={<>
            <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} className="btn btn-primary">{form.id ? 'Save Changes' : 'Create PO'}</button>
          </>}>
          {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div><label className="block text-slate-500 text-xs mb-1">PO Number *</label>
              <input value={form.po_number || ''} onChange={(e) => setForm({ ...form, po_number: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Order Date</label>
              <input type="date" value={form.order_date || ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Supplier</label>
              <select value={form.supplier_id ?? ''} onChange={(e) => setForm({ ...form, supplier_id: e.target.value ? Number(e.target.value) : '' })} className="input">
                <option value="">Select supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.company || s.name}</option>)}
              </select></div>
            <div><label className="block text-slate-500 text-xs mb-1">Status</label>
              <select value={form.status || 'Ordered'} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Notes</label>
              <input value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" /></div>
          </div>

          <div className="mb-1 text-xs font-medium text-slate-500 uppercase">Purchase Lines</div>
          <div className="space-y-2">
            {form.lines.map((ln, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
                <select value={ln.product_id ?? ''} onChange={(e) => setLine(i, 'product_id', e.target.value ? Number(e.target.value) : '')} className="input col-span-5 py-1.5">
                  <option value="">Select product…</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.model} {p.item_code ? `(${p.item_code})` : ''}</option>)}
                </select>
                <input value={ln.quantity ?? ''} type="number" onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="Qty" className="input col-span-2 py-1.5" />
                <input value={ln.rate ?? ''} type="number" onChange={(e) => setLine(i, 'rate', e.target.value)} placeholder="Rate" className="input col-span-2 py-1.5" />
                <div className="col-span-2 text-slate-600">{ln.amount ? fmtNum(ln.amount) : ''}</div>
                <button onClick={() => { if (form.lines.length > 1) setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) }) }} className="col-span-1 text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <button onClick={() => setForm({ ...form, lines: [...form.lines, { product_id: '', description: '', quantity: '', received_qty: 0, rate: '', amount: '' }] })} className="btn btn-ghost mt-2 text-xs"><Plus size={12} className="inline mr-1" />Add line</button>
        </Modal>
      )}
    </div>
  )
}

function ReceiveModal({ po, onClose, onDone }) {
  const [qty, setQty] = useState({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const doReceive = async (lineId, received) => {
    setBusy(true); setErr(null)
    try {
      await api.post(`/purchases/${po.id}/receive`, null, { params: { line_id: lineId, received_qty: Number(received) } })
      onDone()
    } catch (e) { setErr(e.response?.data?.detail || 'Receive failed') } finally { setBusy(false) }
  }

  return (
    <Modal open title={`Receive Material — ${po.po_number}`} onClose={onClose} wide>
      {err && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{err}</div>}
      <Table columns={[
        { key: 'product', label: 'Product', render: (l) => <span className="font-medium">{l.product?.model || l.description}</span> },
        { key: 'ordered', label: 'Ordered', render: (l) => fmtNum(l.quantity) },
        { key: 'received', label: 'Received', render: (l) => fmtNum(l.received_qty) },
        { key: 'pending', label: 'Pending', render: (l) => <span className={(l.quantity || 0) - (l.received_qty || 0) > 0 ? 'text-amber-600' : 'text-green-600'}>{fmtNum((l.quantity || 0) - (l.received_qty || 0))}</span> },
        { key: 'qty', label: 'Receive qty', render: (l) => {
          const pending = (l.quantity || 0) - (l.received_qty || 0)
          return <input type="number" value={qty[l.id] ?? (pending > 0 ? pending : '')} min="0" onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} className="input w-24" disabled={pending <= 0} />
        }},
        { key: 'action', label: '', render: (l) => {
          const pending = (l.quantity || 0) - (l.received_qty || 0)
          return <button disabled={busy || pending <= 0} onClick={() => doReceive(l.id, qty[l.id] || pending)} className="btn btn-accent text-xs py-1.5">{busy ? 'Saving…' : 'Receive'}</button>
        }},
      ]} data={po.lines || []} />
      <div className="flex justify-end mt-4"><button onClick={onClose} className="btn btn-secondary">Close</button></div>
    </Modal>
  )
}