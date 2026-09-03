import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Download, ArrowDownCircle, ArrowUpCircle, Settings, ArrowUpDown, PackageOpen, Boxes } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
import { fmtNum } from '../lib/format'

const MOVEMENT_CLS = {
  RECEIPT: 'bg-green-100 text-green-700',
  PURCHASE_RECEIPT: 'bg-green-100 text-green-700',
  PRODUCTION_OUTPUT: 'bg-blue-100 text-blue-700',
  OPENING: 'bg-slate-100 text-slate-600',
  ISSUE: 'bg-amber-100 text-amber-700',
  CONSUMPTION: 'bg-amber-100 text-amber-700',
  RM_CONSUMPTION: 'bg-amber-100 text-amber-700',
  DISPATCH: 'bg-purple-100 text-purple-700',
  ADJUSTMENT: 'bg-red-100 text-red-700',
  TRANSFER: 'bg-cyan-100 text-cyan-700',
}

const isInward = (t) => ['RECEIPT', 'PURCHASE_RECEIPT', 'PRODUCTION_OUTPUT', 'OPENING'].includes(t)

export default function StockMovements() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState([])
  const [movementType, setMovementType] = useState('')
  const [productId, setProductId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({})
  const [err, setErr] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const params = {}
      if (movementType) params.movement_type = movementType
      if (productId) params.product_id = productId
      if (dateFrom) params.date_from = dateFrom
      if (dateTo) params.date_to = dateTo
      const res = await api.get('/inventory/movements', { params })
      setItems(res.data.items || [])
    } catch { setItems([]) } finally { setLoading(false) }
  }

  useEffect(() => {
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || [])).catch(() => {})
  }, [])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [movementType, productId, dateFrom, dateTo])

  const addMovement = async () => {
    if (!form.product_id || !(form.quantity > 0) || !form.movement_type) { setErr('Product, movement type and positive quantity required'); return }
    try {
      await api.post('/inventory/movements', {
        product_id: Number(form.product_id),
        movement_type: form.movement_type,
        quantity: Number(form.quantity),
        transaction_date: form.transaction_date || new Date().toISOString().slice(0, 10),
        remarks: form.remarks || '',
      })
      setShowForm(false); setForm({}); setErr(null); load()
    } catch (e) { setErr(e.response?.data?.detail || 'Failed to record movement') }
  }

  const movementTypes = ['RECEIPT', 'PURCHASE_RECEIPT', 'PRODUCTION_OUTPUT', 'OPENING', 'ISSUE', 'CONSUMPTION', 'RM_CONSUMPTION', 'DISPATCH', 'ADJUSTMENT', 'TRANSFER']

  const inward = items.filter((m) => isInward(m.movement_type)).length
  const outward = items.length - inward
  const net = items.reduce((s, m) => s + (isInward(m.movement_type) ? (Number(m.quantity) || 0) : -(Number(m.quantity) || 0)), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Stock Movements" subtitle="Every stock change recorded (receipts, issues, production, adjustments)"
        actions={
          <>
            <a href="/api/reports/inventory/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={() => { setForm({}); setErr(null); setShowForm(true) }} className="btn btn-primary"><Plus size={15} /> Record Movement</button>
          </>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total Movements" value={items.length} icon={ArrowUpDown} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Inward" value={inward} icon={ArrowDownCircle} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Outward" value={outward} icon={ArrowUpCircle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        <StatCard label="Net Qty" value={fmtNum(net)} icon={Boxes} iconClass={net >= 0 ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'} />
      </div>

      <Card actions={
        <div className="flex items-center gap-2 flex-wrap">
          <select value={movementType} onChange={(e) => setMovementType(e.target.value)} className="input">
            <option value="">All types</option>
            {movementTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={productId} onChange={(e) => setProductId(e.target.value)} className="input max-w-44">
            <option value="">All products</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
          </select>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input" />
          <span className="text-slate-400 text-xs">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input" />
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Date</th><th>Product</th>
                <th>Type</th><th className="text-right">Qty</th>
                <th>UOM</th><th>Reference</th>
                <th>Remarks</th><th>Source</th>
              </tr></thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <td>{m.transaction_date}</td>
                    <td className="!sticky left-0 bg-inherit font-medium">{m.product?.model || `#${m.product_id}`}</td>
                    <td><Badge className={MOVEMENT_CLS[m.movement_type] || 'bg-gray-100 text-gray-600'}>{m.movement_type}</Badge></td>
                    <td className={`text-right font-semibold ${isInward(m.movement_type) ? 'text-green-600' : 'text-red-600'}`}>
                      {isInward(m.movement_type) ? '+' : '−'}{fmtNum(m.quantity)}
                    </td>
                    <td>{m.product?.uom || '—'}</td>
                    <td className="text-xs text-slate-500">{m.ref_type ? `${m.ref_type}${m.ref_id ? `#${m.ref_id}` : ''}` : 'Manual'}</td>
                    <td className="text-xs text-slate-500">{m.remarks || '—'}</td>
                    <td>{m.ref_type ? <Settings size={14} className="text-slate-300" /> : <ArrowDownCircle size={14} className="text-amber-400" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={showForm} title="Record Stock Movement" onClose={() => setShowForm(false)} wide
        footer={<>
          <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={addMovement} className="btn btn-primary">Record</button>
        </>}>
        {err && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{err}</div>}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Product *</label>
            <select value={form.product_id ?? ''} onChange={(e) => setForm({ ...form, product_id: e.target.value ? Number(e.target.value) : '' })} className="input">
              <option value="">Select product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.model} ({p.category})</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Movement Type *</label>
            <select value={form.movement_type || ''} onChange={(e) => setForm({ ...form, movement_type: e.target.value })} className="input">
              <option value="">Select type…</option>
              {movementTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Quantity *</label>
            <input type="number" step="any" value={form.quantity ?? ''} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Date</label>
            <input type="date" value={form.transaction_date || new Date().toISOString().slice(0, 10)} onChange={(e) => setForm({ ...form, transaction_date: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Remarks / Reason</label>
            <input value={form.remarks || ''} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="input" /></div>
        </div>
      </Modal>
    </div>
  )
}