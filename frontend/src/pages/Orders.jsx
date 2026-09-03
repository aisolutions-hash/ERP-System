import { useEffect, useState } from 'react'
import { Plus, Download, Eye, Pencil, X, ShoppingBag, Layers, CheckCircle2, Clock } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, PageTabs, StatCard, StatusBadge } from '../components/ui'
import Table from '../components/Table'
import { FlowBadge } from '../lib/format'
import { fmtNum } from '../lib/format'

const TABS = [
  { key: 'all', label: 'All', icon: <Layers size={15} /> },
  { key: 'oem', label: 'OEM', icon: <ShoppingBag size={15} /> },
  { key: 'trading', label: 'Trading', icon: <ShoppingBag size={15} /> },
  { key: 'local', label: 'Local', icon: <ShoppingBag size={15} /> },
]

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
  const [form, setForm] = useState({})
  const [lineForm, setLineForm] = useState({})
  const [customers, setCustomers] = useState([])
  const [products, setProducts] = useState([])
  const [salespersons, setSalespersons] = useState([])

  const loadMeta = () => {
    api.get('/customers', { params: { page_size: 500 } }).then((r) => setCustomers(r.data.items || []))
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || []))
    api.get('/salespersons').then((r) => setSalespersons(r.data.items || []))
  }

  const load = (p) => {
    setLoading(true)
    const params = { page_size: 500 }
    if (tab !== 'all') params.order_type = tab.toUpperCase()
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

  const saveLine = () => {
    if (!lineForm.id) return
    api.patch(`/orders/lines/${lineForm.id}`, { product_id: lineForm.product_id, description: lineForm.description, quantity: Number(lineForm.quantity), unit_price: lineForm.unit_price != null ? Number(lineForm.unit_price) : null, amount: lineForm.amount != null ? Number(lineForm.amount) : null, customer_po_no: lineForm.customer_po_no })
      .then((res) => { setDetail(res.data); setEditLine(null); setLineForm({}) })
  }

  const saveOrder = () => {
    const payload = {
      customer_id: form.customer_id || null, order_type: tab === 'all' ? 'OEM' : tab.toUpperCase(),
      customer_po_no: form.customer_po_no || '', salesperson_id: form.salesperson_id || null,
      order_date: form.order_date || new Date().toISOString().slice(0, 10),
      remarks: form.remarks || '', status: form.status || 'new',
      lines: (form.lines || []).map((l) => ({ product_id: l.product_id || null, description: l.description || '', quantity: Number(l.quantity || 0), customer_po_no: l.customer_po_no || '' })),
    }
    api.post('/orders', payload).then((res) => { setShowCreate(false); setForm({}); load() })
  }

  const orderCols = [
    { key: 'order_no', label: 'Order No', render: (r) => <span className="font-mono text-xs font-medium">{r.order_no}</span> },
    { key: 'customer', label: 'Customer', render: (r) => <span className="font-medium">{r.customer?.name || '—'}</span> },
    { key: 'order_type', label: 'Type', render: (r) => <Badge className={r.order_type === 'OEM' ? 'bg-slate-800 text-white' : r.order_type === 'TRADING' ? 'bg-cyan-100 text-cyan-700' : 'bg-teal-100 text-teal-700'}>{r.order_type}</Badge> },
    { key: 'customer_po_no', label: 'PO No', render: (r) => <span className="font-mono text-xs">{r.customer_po_no || '—'}</span> },
    { key: 'order_date', label: 'Order Date' },
    { key: 'lines', label: 'Lines', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.lines?.length || 0}</Badge> },
    { key: 'dispatch_qty', label: 'Dispatched', render: (r) => fmtNum(r.dispatch_qty) },
    { key: 'total_value', label: 'Value', render: (r) => <span className="font-mono text-xs font-medium">{fmtNum(r.total_value)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'actions', label: '', render: (r) => (
      <button onClick={() => openDetail(r)} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="View order"><Eye size={15} /></button>
    )},
  ]

  const lineDetailCols = [
    { key: 'product', label: 'Product', render: (r) => <span className="font-medium">{r.product?.model || r.description || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.product?.item_code || '—'}</span> },
    { key: 'quantity', label: 'Ordered Qty', render: (r) => fmtNum(r.quantity) },
    { key: 'dispatched_qty', label: 'Dispatched', render: (r) => r.dispatched_qty > 0 ? fmtNum(r.dispatched_qty) : '—' },
    { key: 'balance_qty', label: 'Balance', render: (r) => r.dispatched_qty > 0 ? <span className={r.balance_qty < 0 ? 'text-red-600 font-semibold' : ''}>{fmtNum(r.balance_qty)}</span> : '—' },
    { key: 'fulfilment', label: 'Fulfilment', render: (r) => <FlowBadge status={r.fulfilment} /> },
    { key: 'source_type', label: 'Source Type', render: (r) => <Badge className="bg-gray-100 text-gray-600">{r.product?.source_type || '—'}</Badge> },
    { key: 'edit', label: '', render: (r) => (
      <button onClick={() => { setEditLine(r); setLineForm({ id: r.id, product_id: r.product?.id || null, description: r.description || '', quantity: r.quantity, unit_price: r.unit_price, amount: r.amount, customer_po_no: r.customer_po_no || '' }) }} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="Edit line"><Pencil size={14} /></button>
    )},
  ]

  const orderTotalValue = items.reduce((s, o) => s + (Number(o.total_value) || 0), 0)
  const completedCount = items.filter((o) => o.status === 'Completed').length

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Orders" subtitle="OEM / Trading / Local order management"
        actions={<button onClick={() => { setForm({}); setShowCreate(true) }} className="btn btn-primary"><Plus size={15} /> New Order</button>} />

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
      <Modal open={!!detailLoading || !!detail} title={detail ? `${detail.order_no} — ${detail.order_type}` : 'Loading…'} onClose={() => { setDetail(null); setDetailLoading(false) }} wide
        footer={<button onClick={() => { setDetail(null); setDetailLoading(false) }} className="btn btn-secondary">Close</button>}>
        {detailLoading ? <Loading /> : detail && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{detail.customer?.name || '—'}</span></div>
              <div><span className="text-slate-500">Status:</span> <StatusBadge status={detail.status} /></div>
              <div><span className="text-slate-500">Order Date:</span> <span className="font-medium">{detail.order_date}</span></div>
              <div><span className="text-slate-500">PO No:</span> <span className="font-mono text-xs">{detail.customer_po_no || '—'}</span></div>
              <div><span className="text-slate-500">Salesperson:</span> {detail.salesperson?.name || '—'}</div>
              <div><span className="text-slate-500">Order Type:</span> <Badge className="bg-slate-100 text-slate-600">{detail.order_type}</Badge></div>
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
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Product</label>
            <select value={lineForm.product_id ?? ''} onChange={(e) => setLineForm({ ...lineForm, product_id: e.target.value ? Number(e.target.value) : null })} className="input">
              <option value="">Select product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.model} {p.item_code ? `(${p.item_code})` : ''}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Description</label>
            <input value={lineForm.description || ''} onChange={(e) => setLineForm({ ...lineForm, description: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Customer PO No</label>
            <input value={lineForm.customer_po_no || ''} onChange={(e) => setLineForm({ ...lineForm, customer_po_no: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Quantity</label>
            <input type="number" value={lineForm.quantity ?? ''} onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Unit Price</label>
            <input type="number" value={lineForm.unit_price ?? ''} onChange={(e) => setLineForm({ ...lineForm, unit_price: e.target.value })} className="input" /></div>
        </div>
      </Modal>

      {/* Create order modal */}
      <Modal open={showCreate} title="Create New Order" onClose={() => setShowCreate(false)} wide
        footer={<>
          <button onClick={() => setShowCreate(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={saveOrder} className="btn btn-primary">Create Order</button>
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Customer</label>
            <select value={form.customer_id ?? ''} onChange={(e) => setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : null })} className="input">
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Customer PO No</label>
            <input value={form.customer_po_no || ''} onChange={(e) => setForm({ ...form, customer_po_no: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Salesperson</label>
            <select value={form.salesperson_id ?? ''} onChange={(e) => setForm({ ...form, salesperson_id: e.target.value ? Number(e.target.value) : null })} className="input">
              <option value="">None</option>
              {salespersons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Order Date</label>
            <input type="date" value={form.order_date || ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Remarks</label>
            <input value={form.remarks || ''} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="input" /></div>
          {/* Lines */}
          <div className="sm:col-span-2 mt-2 border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between mb-2"><span className="font-medium text-slate-700 text-sm">Order Lines</span>
              <button onClick={() => setForm({ ...form, lines: [...(form.lines || []), { product_id: null, description: '', quantity: 0, customer_po_no: '' }] })} className="btn btn-secondary text-xs py-1.5"><Plus size={13} /> Add Line</button>
            </div>
            {(form.lines || []).map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-center">
                <select value={l.product_id ?? ''} onChange={(e) => {
                  const lines = [...(form.lines || [])]; lines[i].product_id = e.target.value ? Number(e.target.value) : null; setForm({ ...form, lines })
                }} className="col-span-5 input py-1.5">
                  <option value="">Product…</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
                </select>
                <input placeholder="Description" value={l.description || ''} onChange={(e) => { const lines = [...(form.lines || [])]; lines[i].description = e.target.value; setForm({ ...form, lines }) }} className="col-span-4 input py-1.5" />
                <input type="number" placeholder="Qty" value={l.quantity || ''} onChange={(e) => { const lines = [...(form.lines || [])]; lines[i].quantity = Number(e.target.value); setForm({ ...form, lines }) }} className="col-span-2 input py-1.5" />
                <button onClick={() => { const lines = [...(form.lines || [])]; lines.splice(i, 1); setForm({ ...form, lines }) }} className="text-red-400 hover:text-red-600"><X size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  )
}