import { useEffect, useState } from 'react'
import { Plus, Download, Eye, Pencil, X, ShoppingBag, Layers, CheckCircle2, Clock, Trash2 } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, PageTabs, StatCard, StatusBadge, SearchSelect } from '../components/ui'
import Table from '../components/Table'
import { FlowBadge } from '../lib/format'
import { fmtNum } from '../lib/format'

const TABS = [
  { key: 'all', label: 'All', icon: <Layers size={15} /> },
  { key: 'oem', label: 'Manufacture', icon: <ShoppingBag size={15} /> },
  { key: 'trading', label: 'Trading', icon: <ShoppingBag size={15} /> },
]

const ORDER_TYPE_OPTIONS = [
  { value: 'OEM', label: 'Manufacture' },
  { value: 'TRADING', label: 'Trading' },
]
const orderTypeLabel = (t) => ORDER_TYPE_OPTIONS.find((o) => o.value === t)?.label || t || '—'

const emptyLine = { product_id: null, description: '', item_code: '', quantity: 1, unit_price: null }

const errText = (err) => {
  const d = err?.response?.data?.detail
  if (Array.isArray(d)) return d.map((x) => x.msg || x).join('. ')
  if (typeof d === 'string') return d
  return 'Order creation failed. Please try again.'
}

export default function Orders() {
  const [tab, setTab] = useState('all')
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusF, setStatusF] = useState('')
  const [customerF, setCustomerF] = useState('')
  const [searchF, setSearchF] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [editLine, setEditLine] = useState(null)
  const [soPoForm, setSoPoForm] = useState(null)
  const [form, setForm] = useState({})
  const [lineForm, setLineForm] = useState({})
  const [customers, setCustomers] = useState([])
  const [products, setProducts] = useState([])
  const [salespersons, setSalespersons] = useState([])
  const [saving, setSaving] = useState(false)
  const [createErrors, setCreateErrors] = useState({})
  const [success, setSuccess] = useState('')

  const loadMeta = () => {
    api.get('/customers', { params: { page_size: 500 } }).then((r) => setCustomers(r.data.items || []))
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || []))
    api.get('/salespersons').then((r) => setSalespersons(r.data.items || []))
  }

  const load = () => {
    setLoading(true)
    const params = { page_size: 500 }
    if (tab !== 'all') params.order_type = tab.toUpperCase()
    params.exclude_order_type = 'LOCAL'
    if (statusF) params.status = statusF
    if (customerF) params.customer_id = Number(customerF)
    if (searchF) params.search = searchF
    api.get('/orders', { params }).then((res) => { setItems(res.data.items || []); setTotal(res.data.total || 0) })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadMeta() }, [])
  useEffect(() => { load() }, [tab, statusF, customerF])

  const openDetail = (r) => {
    setDetailLoading(true)
    api.get(`/orders/${r.id}`).then((res) => { setDetail(res.data) }).catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }

  const removeOrder = (r) => {
    if (!window.confirm(`Delete order ${r.order_no}? This cannot be undone.`)) return
    api.delete(`/orders/${r.id}`)
      .then(() => {
        setDetail(null)
        setDetailLoading(false)
        setSuccess(`Order ${r.order_no} deleted`)
        setTimeout(() => setSuccess(''), 6000)
        load()
      })
      .catch((err) => {
        const d = err?.response?.data?.detail
        window.alert(typeof d === 'string' ? d : 'Failed to delete order.')
      })
  }

  const saveLine = () => {
    if (!lineForm.id) return
    api.patch(`/orders/lines/${lineForm.id}`, {
      product_id: lineForm.product_id, description: lineForm.description,
      item_code: (lineForm.item_code || '').trim(),
      quantity: Number(lineForm.quantity),
      unit_price: lineForm.unit_price != null ? Number(lineForm.unit_price) : null,
      less: lineForm.less != null && lineForm.less !== '' ? Number(lineForm.less) : null,
      amount: lineForm.amount != null ? Number(lineForm.amount) : null,
      customer_po_no: lineForm.customer_po_no,
    })
      .then((res) => { setDetail(res.data); setEditLine(null); setLineForm({}) })
  }

  const saveSoPo = () => {
    if (!soPoForm || !detail) return
    if (!(soPoForm.order_no || '').trim()) { window.alert('SO Number is required and cannot be blank.'); return }
    api.patch(`/orders/${detail.id}`, {
      order_no: soPoForm.order_no.trim(),
      customer_po_no: soPoForm.customer_po_no || '',
    })
      .then((res) => { setDetail(res.data); setSoPoForm(null) })
      .catch((err) => {
        const d = err?.response?.data?.detail
        window.alert(typeof d === 'string' ? d : 'Failed to update order details.')
      })
  }

  const openCreate = () => {
    setForm({
      customer_id: null,
      customer_name: '',
      order_type: tab === 'all' ? 'OEM' : tab.toUpperCase(),
      order_no: '',
      customer_po_no: '',
      salesperson_id: null,
      salesperson_name: '',
      order_date: new Date().toISOString().slice(0, 10),
      remarks: '',
      lines: [{ ...emptyLine }],
    })
    setCreateErrors({})
    setShowCreate(true)
  }

  const closeCreate = () => {
    setShowCreate(false)
    setSaving(false)
    setCreateErrors({})
  }

  const addLine = () => {
    setForm({ ...form, lines: [...(form.lines || []), { ...emptyLine }] })
  }

  const updateLine = (i, key, value) => {
    const lines = [...(form.lines || [])]
    lines[i] = { ...lines[i], [key]: value }
    setForm({ ...form, lines })
  }

  const removeLine = (i) => {
    setForm({ ...form, lines: (form.lines || []).filter((_, idx) => idx !== i) })
  }

  const lineTotal = (l) => (Number(l.quantity) || 0) * (Number(l.unit_price) || 0)

  const orderTotal = (form.lines || []).reduce((s, l) => s + lineTotal(l), 0)

  const validateCreate = () => {
    const errs = {}
    if (!form.customer_id && !(form.customer_name || '').trim()) errs.customer_id = 'Select or type a customer'
    if (!(form.order_no || '').trim()) errs.order_no = 'SO Number is required'
    const lines = form.lines || []
    if (lines.length === 0) errs.lines = 'Add at least one product line'
    lines.forEach((l, i) => {
      if (!l.product_id && !(l.description || '').trim()) errs[`line_${i}_product`] = 'Select a product or type an item description'
      if (!(Number(l.quantity) > 0)) errs[`line_${i}_qty`] = 'Qty > 0 required'
    })
    setCreateErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleProductLine = (i, id, manual) => {
    const lines = [...(form.lines || [])]
    if (id) {
      const product = products.find((p) => String(p.id) === String(id))
      lines[i] = {
        ...lines[i],
        product_id: id,
        description: manual || lines[i].description,
        item_code: product?.item_code || lines[i].item_code || '',
      }
    } else {
      lines[i] = { ...lines[i], product_id: null, description: manual || '' }
    }
    setForm({ ...form, lines })
  }

  const submitCreate = () => {
    if (!validateCreate()) return
    setSaving(true)
    const payload = {
      customer_id: form.customer_id,
      customer_name: (form.customer_name || '').trim(),
      order_type: form.order_type,
      order_no: (form.order_no || '').trim(),
      customer_po_no: form.customer_po_no || '',
      salesperson_id: form.salesperson_id || null,
      salesperson_name: (form.salesperson_name || '').trim(),
      order_date: form.order_date || new Date().toISOString().slice(0, 10),
      remarks: form.remarks || '',
      lines: (form.lines || []).map((l) => ({
        product_id: l.product_id,
        description: l.description || '',
        item_code: (l.item_code || '').trim(),
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price) || null,
        amount: lineTotal(l) || null,
        customer_po_no: '',
      })),
    }
    api.post('/orders', payload)
      .then((res) => {
        closeCreate()
        setSuccess(`Order ${res.data.order_no} created successfully`)
        setTimeout(() => setSuccess(''), 6000)
        load()
      })
      .catch((err) => setCreateErrors({ api: errText(err) }))
      .finally(() => setSaving(false))
  }

  const orderCols = [
    { key: 'order_no', label: 'SO No', render: (r) => <span className="font-mono text-xs font-medium">{r.order_no}</span> },
    { key: 'customer', label: 'Customer', render: (r) => <span className="font-medium">{r.customer?.name || '—'}</span> },
    { key: 'order_type', label: 'Type', render: (r) => <Badge className={r.order_type === 'OEM' ? 'bg-slate-800 text-white' : 'bg-cyan-100 text-cyan-700'}>{orderTypeLabel(r.order_type)}</Badge> },
    { key: 'customer_po_no', label: 'PO No', render: (r) => <span className="font-mono text-xs">{r.customer_po_no || '—'}</span> },
    { key: 'order_date', label: 'Order Date' },
    { key: 'lines', label: 'Lines', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.lines?.length || 0}</Badge> },
    { key: 'dispatch_qty', label: 'Dispatched', render: (r) => fmtNum(r.dispatch_qty) },
    { key: 'total_value', label: 'Value', render: (r) => <span className="font-mono text-xs font-medium">{fmtNum(r.total_value)}</span> },
    { key: 'stock_status', label: 'Stock', render: (r) => r.ready
        ? <FlowBadge status="READY_FOR_DISPATCH" />
        : r.stock_status ? <FlowBadge status={r.stock_status} /> : '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'actions', label: '', render: (r) => (
      <div className="flex items-center justify-end gap-1">
        <button onClick={() => openDetail(r)} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="View order"><Eye size={15} /></button>
        <button onClick={(e) => { e.stopPropagation(); removeOrder(r) }} className="text-slate-400 hover:text-red-600 p-1 hover:bg-red-50 rounded" title="Delete order"><Trash2 size={14} /></button>
      </div>
    )},
  ]

  const lineDetailCols = [
    { key: 'product', label: 'Product', render: (r) => <span className="font-medium">{r.product?.model || r.description || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || r.product?.item_code || '—'}</span> },
    { key: 'quantity', label: 'Ordered Qty', render: (r) => fmtNum(r.quantity) },
    { key: 'dispatched_qty', label: 'Dispatched', render: (r) => r.dispatched_qty > 0 ? fmtNum(r.dispatched_qty) : '—' },
    { key: 'balance_qty', label: 'Balance', render: (r) => r.dispatched_qty > 0 ? <span className={r.balance_qty < 0 ? 'text-red-600 font-semibold' : ''}>{fmtNum(r.balance_qty)}</span> : '—' },
    { key: 'available_stock', label: 'In Stock', render: (r) => <span className={Number(r.available_stock || 0) > 0 ? 'text-green-700' : 'text-slate-400'}>{fmtNum(r.available_stock)}</span> },
    { key: 'shortage_qty', label: 'Shortage', render: (r) => Number(r.shortage_qty || 0) > 0 ? <span className="font-semibold text-red-600">{fmtNum(r.shortage_qty)}</span> : '—' },
    { key: 'rate', label: 'Rate', render: (r) => r.unit_price != null ? fmtNum(r.unit_price) : '—' },
    { key: 'less', label: 'Less', render: (r) => r.less != null ? fmtNum(r.less) : '—' },
    { key: 'amount', label: 'Amount', render: (r) => r.amount != null ? fmtNum(r.amount) : '—' },
    { key: 'readiness', label: 'Fulfilment', render: (r) => <FlowBadge status={r.readiness || r.fulfilment} /> },
    { key: 'source_type', label: 'Source Type', render: (r) => <Badge className="bg-gray-100 text-gray-600">{r.product?.source_type || '—'}</Badge> },
    { key: 'edit', label: '', render: (r) => (
      <button onClick={() => { setEditLine(r); setLineForm({ id: r.id, product_id: r.product?.id || null, description: r.description || '', item_code: r.item_code || r.product?.item_code || '', quantity: r.quantity, unit_price: r.unit_price, less: r.less ?? '', amount: r.amount, customer_po_no: r.customer_po_no || '' }) }} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="Edit line"><Pencil size={14} /></button>
    )},
  ]

  const orderTotalValue = items.reduce((s, o) => s + (Number(o.total_value) || 0), 0)
  const completedCount = items.filter((o) => o.status === 'Completed').length

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Orders" subtitle="Manufacture / Trading order management"
        actions={<button onClick={openCreate} className="btn btn-primary"><Plus size={15} /> New Order</button>} />

      {success && (
        <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 flex items-center gap-2">
          <CheckCircle2 size={16} /> {success}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Visible Orders" value={total} sub={`${items.length} shown`} icon={ShoppingBag} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Completed" value={completedCount} sub="of visible" icon={CheckCircle2} iconClass="bg-green-50 text-green-600" />
        <StatCard label="Total Value" value={fmtNum(orderTotalValue)} sub="visible scope" icon={Clock} iconClass="bg-blue-50 text-blue-600" />
      </div>

      <PageTabs tabs={TABS.map((t) => ({ ...t, count: t.key === 'all' ? total : undefined }))} active={tab} onChange={setTab} />

      {/* Filters */}
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <input value={searchF} onChange={(e) => setSearchF(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Search order no…" className="input sm:w-52" />
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="input sm:w-auto">
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="confirmed">Confirmed</option>
          <option value="in_production">In Production</option>
          <option value="ready">Ready</option>
          <option value="dispatched">Dispatched</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select value={customerF} onChange={(e) => setCustomerF(e.target.value)} className="input sm:w-auto">
          <option value="">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={load} className="btn btn-secondary"><Download size={14} /> Search</button>
      </div>

      <Card>
        {loading ? <Loading /> : items.length === 0 ? <Empty text="No orders found" /> : <Table columns={orderCols} data={items} keyField="id" onRowClick={openDetail} stickyColumns={['order_no']} />}
      </Card>

      {/* Order detail modal */}
      <Modal open={!!detailLoading || !!detail} title={detail ? `${detail.order_no} — ${orderTypeLabel(detail.order_type)}` : 'Loading…'} onClose={() => { setDetail(null); setDetailLoading(false) }} wide
        footer={<>
          <button onClick={() => { setDetail(null); setDetailLoading(false) }} className="btn btn-secondary">Close</button>
          <button onClick={() => removeOrder(detail)} className="btn btn-danger">Delete Order</button>
        </>}>
        {detailLoading ? <Loading /> : detail && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{detail.customer?.name || '—'}</span></div>
              <div><span className="text-slate-500">Status:</span> <StatusBadge status={detail.status} /></div>
              <div><span className="text-slate-500">Stock:</span> {detail.ready
                ? <FlowBadge status="READY_FOR_DISPATCH" />
                : <FlowBadge status={detail.stock_status || 'MANUAL_DECISION_REQUIRED'} />}</div>
              <div><span className="text-slate-500">Order Date:</span> <span className="font-medium">{detail.order_date}</span></div>
              <div><span className="text-slate-500">SO No:</span> <span className="font-mono text-xs">{detail.order_no || '—'}</span>
                <button onClick={() => setSoPoForm({ order_no: detail.order_no || '', customer_po_no: detail.customer_po_no || '' })} className="ml-2 text-blue-500 hover:text-blue-700 p-1 align-middle" title="Edit SO / PO number"><Pencil size={13} /></button></div>
              <div><span className="text-slate-500">PO No:</span> <span className="font-mono text-xs">{detail.customer_po_no || '—'}</span></div>
              <div><span className="text-slate-500">Salesperson:</span> {detail.salesperson?.name || '—'}</div>
              <div><span className="text-slate-500">Order Type:</span> <Badge className="bg-slate-100 text-slate-600">{orderTypeLabel(detail.order_type)}</Badge></div>
              <div><span className="text-slate-500">Dispatched (order-level):</span> <span className="font-semibold">{fmtNum(detail.dispatch_qty)}</span></div>
              <div><span className="text-slate-500">Value:</span> <span className="font-medium">{fmtNum(detail.total_value)}</span></div>
            </div>
            {detail.lines?.length > 1 && (
              <div className="mb-3 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                Dispatched qty shown at order level (not per-line) — dispatches in source data are tied to orders, not individual lines.
              </div>
            )}
            <Table columns={lineDetailCols} data={detail.lines || []} keyField="id" stickyColumns={['product']} dense />
          </>
        )}
      </Modal>

      {/* Edit line modal */}
      <Modal open={!!editLine} title="Edit Order Line" onClose={() => { setEditLine(null); setLineForm({}) }} wide
        footer={<>
          <button onClick={() => { setEditLine(null); setLineForm({}) }} className="btn btn-secondary">Cancel</button>
          <button onClick={saveLine} className="btn btn-primary">Save</button>
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Item</label>
            <SearchSelect
              options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''} · ${p.uom || 'Each'}` }))}
              value={lineForm.product_id ?? null}
              initialLabel={!lineForm.product_id ? (lineForm.description || '') : ''}
              placeholder="Type to search products or keep the manual description"
              onChange={(id, manual) => setLineForm((lf) => {
                const p = products.find((x) => String(x.id) === String(id))
                return {
                  ...lf,
                  product_id: id,
                  description: manual || lf.description,
                  item_code: id ? (p?.item_code || lf.item_code || '') : lf.item_code,
                }
              })}
            />
          </div>
          <div><label className="block text-slate-500 text-xs mb-1">Description</label>
            <input value={lineForm.description || ''} onChange={(e) => setLineForm({ ...lineForm, description: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Item Code</label>
            <input value={lineForm.item_code || ''} onChange={(e) => setLineForm({ ...lineForm, item_code: e.target.value })} placeholder="Item code" className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Customer PO No</label>
            <input value={lineForm.customer_po_no || ''} onChange={(e) => setLineForm({ ...lineForm, customer_po_no: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Quantity</label>
            <input type="number" value={lineForm.quantity ?? ''} onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Unit Price</label>
            <input type="number" value={lineForm.unit_price ?? ''} onChange={(e) => setLineForm({ ...lineForm, unit_price: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Less</label>
            <input type="number" value={lineForm.less ?? ''} onChange={(e) => setLineForm({ ...lineForm, less: e.target.value })} className="input" /></div>
        </div>
      </Modal>

      {/* Create order modal */}
      <Modal open={showCreate} title="Create New Order" onClose={closeCreate} wide
        footer={<>
          <button onClick={closeCreate} className="btn btn-secondary" disabled={saving}>Cancel</button>
          <button onClick={submitCreate} disabled={saving} className="btn btn-primary">{saving ? 'Creating…' : 'Create Order'}</button>
        </>}>
        {createErrors.api && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{createErrors.api}</div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2">
            <label className="block text-slate-500 text-xs mb-1">Customer <span className="text-red-500">*</span></label>
            <SearchSelect
              options={customers.map((c) => ({ id: c.id, label: c.name }))}
              value={form.customer_id}
              initialLabel={!form.customer_id ? (form.customer_name || '') : ''}
              placeholder="Type to search or enter a customer name — existing customers match automatically"
              onChange={(id, manual) => setForm((f) => ({ ...f, customer_id: id, customer_name: manual }))}
            />
            {createErrors.customer_id && <p className="text-xs text-red-600 mt-1">{createErrors.customer_id}</p>}
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">Order Type</label>
            <select value={form.order_type || 'OEM'} onChange={(e) => setForm({ ...form, order_type: e.target.value })} className="input">
              {ORDER_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">Order Date</label>
            <input type="date" value={form.order_date || ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} className="input" />
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">SO Number <span className="text-red-500">*</span> <span className="text-slate-400 font-normal">(manual)</span></label>
            <input value={form.order_no || ''} onChange={(e) => setForm({ ...form, order_no: e.target.value })} placeholder="Enter the actual Sales Order no." className="input" />
            {createErrors.order_no && <p className="text-xs text-red-600 mt-1">{createErrors.order_no}</p>}
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">Customer PO No</label>
            <input value={form.customer_po_no || ''} onChange={(e) => setForm({ ...form, customer_po_no: e.target.value })} placeholder="PO / reference no" className="input" />
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">Salesperson</label>
            <SearchSelect
              options={salespersons.map((s) => ({ id: s.id, label: s.name }))}
              value={form.salesperson_id}
              initialLabel={!form.salesperson_id ? (form.salesperson_name || '') : ''}
              placeholder="Type a salesperson name or select…"
              onChange={(id, manual) => setForm((f) => ({ ...f, salesperson_id: id, salesperson_name: manual }))}
            />
          </div>

          {/* Order lines */}
          <div className="sm:col-span-2 mt-2 border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-slate-700 text-sm">Order Items</span>
              <button onClick={addLine} className="btn btn-secondary text-xs py-1.5"><Plus size={13} /> Add Item</button>
            </div>

            {(form.lines || []).map((l, i) => {
              return (
                <div key={i} className="relative grid grid-cols-2 sm:grid-cols-12 gap-2 mb-3 p-3 rounded-lg bg-slate-50/70 border border-gray-100">
                  <button onClick={() => removeLine(i)} className="absolute top-2 right-2 text-red-400 hover:text-red-600 p-1 hover:bg-red-50 rounded" title="Remove item"><X size={14} /></button>
                  <div className="col-span-2 sm:col-span-4">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Product <span className="text-red-500">*</span> <span className="text-slate-400 font-normal">(or type manual)</span></label>
                    <SearchSelect
                      options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''} · ${p.uom || 'Each'}` }))}
                      value={l.product_id}
                      initialLabel={!l.product_id ? (l.description || '') : ''}
                      placeholder="Search product / manual item…"
                      onChange={(id, manual) => handleProductLine(i, id, manual)}
                    />
                    {createErrors[`line_${i}_product`] && <p className="text-xs text-red-600 mt-1">{createErrors[`line_${i}_product`]}</p>}
                  </div>
                  <div className="col-span-2 sm:col-span-3">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Item Code</label>
                    <input type="text" value={l.item_code || ''} onChange={(e) => updateLine(i, 'item_code', e.target.value)} placeholder="Item code" className="input py-1.5" />
                  </div>
                  <div className="col-span-2 sm:col-span-5">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Items / Description</label>
                    <input value={l.description || ''} onChange={(e) => updateLine(i, 'description', e.target.value)} placeholder="Description" className="input py-1.5" />
                  </div>
                  <div className="col-span-1 sm:col-span-4">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Qty <span className="text-red-500">*</span></label>
                    <input type="number" min="1" step="any" value={l.quantity ?? ''} onChange={(e) => updateLine(i, 'quantity', e.target.value)} className="input py-1.5" />
                    {createErrors[`line_${i}_qty`] && <p className="text-xs text-red-600 mt-1">{createErrors[`line_${i}_qty`]}</p>}
                  </div>
                  <div className="col-span-1 sm:col-span-4">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Rate</label>
                    <input type="number" min="0" step="any" value={l.unit_price ?? ''} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} placeholder="0" className="input py-1.5" />
                  </div>
                  <div className="col-span-1 sm:col-span-4">
                    <label className="block text-slate-500 text-[0.6875rem] mb-1">Amount</label>
                    <div className="input input-num py-1.5 bg-white text-right font-mono text-slate-800 whitespace-nowrap overflow-hidden text-ellipsis">{fmtNum(lineTotal(l))}</div>
                  </div>
                </div>
              )
            })}

            {createErrors.lines && <p className="text-xs text-red-600 mt-1">{createErrors.lines}</p>}

            <div className="flex items-center justify-between border-t border-gray-100 pt-3 mt-1">
              <span className="text-xs text-slate-500">Items: {(form.lines || []).length}</span>
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600 font-medium">Order Total</span>
                <span className="text-base font-bold text-slate-900 font-mono">{fmtNum(orderTotal)}</span>
              </div>
            </div>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-slate-500 text-xs mb-1">Notes / Remarks</label>
            <textarea value={form.remarks || ''} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} className="input" />
          </div>
        </div>
      </Modal>

      {/* Edit SO / PO number modal */}
      <Modal open={!!soPoForm} title="Edit SO / PO Number" onClose={() => setSoPoForm(null)} wide
        footer={<>
          <button onClick={() => setSoPoForm(null)} className="btn btn-secondary">Cancel</button>
          <button onClick={saveSoPo} className="btn btn-primary">Save</button>
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-slate-500 text-xs mb-1">SO Number <span className="text-red-500">*</span></label>
            <input value={soPoForm?.order_no || ''} onChange={(e) => setSoPoForm((f) => ({ ...f, order_no: e.target.value }))} placeholder="Actual Sales Order no." className="input" />
          </div>
          <div>
            <label className="block text-slate-500 text-xs mb-1">Customer PO No</label>
            <input value={soPoForm?.customer_po_no || ''} onChange={(e) => setSoPoForm((f) => ({ ...f, customer_po_no: e.target.value }))} placeholder="PO / reference no" className="input" />
          </div>
          <div className="sm:col-span-2 text-xs text-slate-500">The exact numbers you enter are saved as-is. No number is auto-generated.</div>
        </div>
      </Modal>
    </div>
  )
}