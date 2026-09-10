import { useEffect, useState } from 'react'
import {
  Plus, Search, Download, Eye, Pencil, Trash2, RefreshCw,
  Package, PackagePlus, CheckCircle2, AlertTriangle, ArrowLeftRight, Truck, History, Warehouse,
} from 'lucide-react'
import api, { downloadFile } from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard, SearchSelect, PageTabs } from '../components/ui'
import Table from '../components/Table'
import StockTransferModal from '../components/StockTransferModal'
import { fmtNum } from '../lib/format'

const statusCls = {
  OK: 'bg-green-100 text-green-700',
  LOW: 'bg-amber-100 text-amber-700',
  OUT_OF_STOCK: 'bg-red-100 text-red-600',
}

const today = () => new Date().toISOString().slice(0, 10)

const blankLine = () => ({ product_id: '', description: '', item_code: '', quantity: '' })

export default function Inventory() {
  const [tab, setTab] = useState('stock')

  // ---- stock tab state ----
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [plantId, setPlantId] = useState('')

  // ---- master data ----
  const [locations, setLocations] = useState([])
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [invIndex, setInvIndex] = useState({})

  // ---- transfers state ----
  const [transfers, setTransfers] = useState([])
  const [transfersTotal, setTransfersTotal] = useState(0)
  const [transLoading, setTransLoading] = useState(false)
  const [transSearch, setTransSearch] = useState('')
  const [showTransferForm, setShowTransferForm] = useState(false)
  const [transferInit, setTransferInit] = useState(null)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  // ---- dispatch history state ----
  const [history, setHistory] = useState([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [histLoading, setHistLoading] = useState(false)
  const [histCustomer, setHistCustomer] = useState('')
  const [histFrom, setHistFrom] = useState('')
  const [histTo, setHistTo] = useState('')
  const [showDispatchForm, setShowDispatchForm] = useState(false)
  const [dispatch, setDispatch] = useState(null)

  // ---- stock add / edit modal ----
  const [showStockModal, setShowStockModal] = useState(false)
  const [stockForm, setStockForm] = useState(null)
  const [stockDetail, setStockDetail] = useState(null)

  const loadStock = () => {
    setLoading(true)
    api.get('/inventory', { params: { search, category, status, plant_id: plantId || undefined } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  const loadInvIndex = () => {
    api.get('/inventory', { params: { page_size: 500 } })
      .then((r) => {
        const idx = {}
        ;(r.data.items || []).forEach((i) => { idx[`${i.product_id}:${i.plant_id ?? ''}`] = Number(i.current_stock) || 0 })
        setInvIndex(idx)
      }).catch(() => {})
  }

  const afterStockMutated = () => {
    loadStock(); loadInvIndex(); refreshCounts()
  }

  const openNewStock = () => {
    setStockForm({
      id: null, product_id: '', description: '', item_code: '',
      quantity: '', unit: '', plant_id: '', transaction_date: today(),
      remarks: '', min_level: '',
    })
    setError(null); setShowStockModal(true)
  }

  const openEditStock = (row) => {
    setStockForm({
      id: row.id, product_id: row.product_id ?? '', description: row.product?.name || '',
      item_code: row.product?.item_code || '', quantity: String(row.current_stock ?? ''),
      unit: row.product?.uom || '', plant_id: row.plant_id ?? '',
      transaction_date: today(), remarks: '', min_level: row.min_level != null ? String(row.min_level) : '',
      hadMin: row.min_level != null,
    })
    setError(null); setShowStockModal(true)
  }

  const saveStock = async () => {
    if (stockForm.id == null) {
      const payload = {
        product_id: stockForm.product_id ? Number(stockForm.product_id) : null,
        item_code: stockForm.item_code || '',
        description: stockForm.description || '',
        quantity: Number(stockForm.quantity || 0),
        unit: stockForm.unit || undefined,
        plant_id: stockForm.plant_id !== '' ? Number(stockForm.plant_id) : null,
        transaction_date: stockForm.transaction_date || today(),
        remarks: stockForm.remarks || '',
        min_level: stockForm.min_level !== '' ? Number(stockForm.min_level) : undefined,
      }
      if (!payload.product_id && !payload.item_code && !payload.description) { setError('Select a product, or type an item code/description'); return }
      if (!(payload.quantity > 0)) { setError('Quantity must be greater than 0'); return }
      try {
        await api.post('/inventory/add-stock', payload)
        setShowStockModal(false); setStockForm(null); setError(null); afterStockMutated()
      } catch (e) { setError(e.response?.data?.detail || 'Add stock failed') }
    } else {
      const payload = {
        quantity: stockForm.quantity !== '' ? Number(stockForm.quantity) : undefined,
        min_level: stockForm.min_level !== '' ? Number(stockForm.min_level) : (stockForm.hadMin ? null : undefined),
        unit: stockForm.unit || undefined,
        item_code: stockForm.item_code || undefined,
        description: stockForm.description || undefined,
        plant_id: stockForm.plant_id !== '' ? Number(stockForm.plant_id) : undefined,
        product_id: stockForm.product_id ? Number(stockForm.product_id) : undefined,
        remarks: stockForm.remarks || undefined,
      }
      try {
        await api.patch(`/inventory/${stockForm.id}`, payload)
        setShowStockModal(false); setStockForm(null); setError(null); afterStockMutated()
      } catch (e) { setError(e.response?.data?.detail || 'Update failed') }
    }
  }

  const delStock = async (row) => {
    if (!confirm(`Delete inventory line for ${row.product?.model || row.product_id} at ${row.plant?.name || 'Main Store'}? This is only allowed when the line is empty and unreferenced.`)) return
    try { await api.delete(`/inventory/${row.id}`); afterStockMutated() }
    catch (e) { alert('Delete failed: ' + (e.response?.data?.detail || e.message)) }
  }

  const loadTransfers = () => {
    setTransLoading(true)
    api.get('/inventory/transfers', { params: { search: transSearch, page_size: 200 } })
      .then((res) => setTransfers(res.data.items))
      .catch(() => setTransfers([]))
      .finally(() => setTransLoading(false))
  }

  const loadHistory = () => {
    setHistLoading(true)
    api.get('/inventory/dispatches/history', {
      params: {
        customer_id: histCustomer || undefined,
        date_from: histFrom || undefined,
        date_to: histTo || undefined,
        page_size: 200,
      },
    })
      .then((res) => setHistory(res.data.items))
      .catch(() => setHistory([]))
      .finally(() => setHistLoading(false))
  }

  // Unfiltered record counts for the tab counters (actual backend totals).
  const refreshCounts = () => {
    api.get('/inventory/transfers', { params: { page_size: 1 } })
      .then((r) => setTransfersTotal(r.data.total || 0)).catch(() => {})
    api.get('/inventory/dispatches/history', { params: { page_size: 1 } })
      .then((r) => setHistoryTotal(r.data.total || 0)).catch(() => {})
  }

  useEffect(() => { loadStock() }, [])
  useEffect(() => { const t = setTimeout(loadStock, 300); return () => clearTimeout(t) }, [search, category, status, plantId])

  useEffect(() => {
    api.get('/inventory/locations').then((r) => setLocations(r.data.items || [])).catch(() => {})
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || [])).catch(() => {})
    api.get('/customers', { params: { page_size: 500 } }).then((r) => setCustomers(r.data.items || [])).catch(() => {})
    loadInvIndex()
    refreshCounts()
  }, [])

  useEffect(() => {
    if (tab === 'transfers') loadTransfers()
    if (tab === 'dispatch') loadHistory()
  }, [tab])

  const locName = (id) => {
    const l = locations.find((x) => String(x.id) === String(id))
    return l ? l.name : (id === '' || id == null ? 'Main Store' : `#${id}`)
  }
  const dispOptions = locations.filter((l) => l.id != null)

  // ---- stock tab derived ----
  const ok = items.filter((i) => i.status === 'OK').length
  const low = items.filter((i) => i.status === 'LOW').length
  const out = items.filter((i) => i.status === 'OUT_OF_STOCK').length
  const totalStock = items.reduce((s, i) => s + (Number(i.current_stock) || 0), 0)

  const stockColumns = [
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
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setStockDetail(r)} className="btn btn-ghost p-1.5" title="View"><Eye size={15} /></button>
          <button onClick={() => openEditStock(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => delStock(r)} className="btn btn-ghost p-1.5 text-red-400" title="Delete"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  // ---- transfer helpers ----
  const openNewTransfer = () => {
    setTransferInit({
      id: null, transfer_no: null,
      from_plant_id: '', to_plant_id: '', customer_id: null, customer_name: '',
      transfer_date: today(), notes: '', lines: [blankLine()],
    })
    setShowTransferForm(true)
  }

  const openEditTransfer = (tr) => {
    setTransferInit({
      id: tr.id, transfer_no: tr.transfer_no, from_plant_id: tr.from_plant_id ?? '',
      to_plant_id: tr.to_plant_id ?? '', customer_id: tr.customer_id ?? null,
      customer_name: tr.customer_name || '', transfer_date: tr.transfer_date,
      notes: tr.notes || '',
      lines: (tr.lines || []).map((l) => ({ product_id: l.product_id ?? '', description: l.description || '', item_code: l.item_code || '', quantity: l.quantity })),
    })
    setShowTransferForm(true)
  }

  const afterTransferSaved = () => {
    loadTransfers(); loadInvIndex(); refreshCounts()
    setTimeout(loadStock, 150)
  }

  // ---- dispatch helpers ----
  const openNewDispatch = () => {
    const seq = String(history.length + 1).padStart(3, '0')
    setDispatch({
      id: null, dispatch_no: `CD-${today().replace(/-/g, '')}-${seq}`,
      customer_id: null, customer_name: '', dispatch_date: today(),
      remarks: '', plant_id: '', lines: [blankLine()],
    })
    setError(null); setShowDispatchForm(true)
  }

  const openEditDispatch = async (row) => {
    try {
      const r = await api.get(`/inventory/dispatches/${row.dispatch_id}`)
      const d = r.data
      setDispatch({
        id: d.id, dispatch_no: d.dispatch_no, customer_id: d.customer_id ?? null,
        customer_name: d.customer_name || '', dispatch_date: d.dispatch_date,
        remarks: d.remarks || '', plant_id: d.plant_id ?? '',
        lines: (d.lines || []).map((l) => ({ product_id: l.product_id ?? '', description: l.description || '', item_code: l.item_code || '', quantity: l.quantity })),
      })
      setError(null); setShowDispatchForm(true)
    } catch (e) { alert('Failed to load dispatch: ' + (e.response?.data?.detail || e.message)) }
  }

  const delDispatch = async (row) => {
    if (!confirm(`Delete dispatch ${row.dispatch_no}? Stock will be restored to the ${row.location} location.`)) return
    try {
      await api.delete(`/inventory/dispatches/${row.dispatch_id}`)
      loadHistory(); loadStock(); loadInvIndex(); refreshCounts()
    } catch (e) { alert('Delete failed: ' + (e.response?.data?.detail || e.message)) }
  }

  const saveDispatch = async () => {
    const payload = {
      dispatch_no: dispatch.dispatch_no || null,
      customer_id: dispatch.customer_id ? Number(dispatch.customer_id) : null,
      customer_name: dispatch.customer_name || '',
      dispatch_date: dispatch.dispatch_date,
      remarks: dispatch.remarks || '',
      plant_id: dispatch.plant_id !== '' ? Number(dispatch.plant_id) : null,
      lines: dispatch.lines.filter((l) => l.product_id || (l.description || '').trim())
        .map((l) => ({
          product_id: l.product_id ? Number(l.product_id) : null,
          description: l.description || '', item_code: l.item_code || '',
          quantity: Number(l.quantity || 0),
        })),
    }
    if (payload.lines.length === 0) { setError('Add at least one line'); return }
    try {
      if (dispatch.id) await api.patch(`/inventory/dispatches/${dispatch.id}`, payload)
      else await api.post('/inventory/dispatches', payload)
      setShowDispatchForm(false); setDispatch(null); setError(null)
      loadHistory(); loadInvIndex(); refreshCounts()
      setTimeout(loadStock, 150)
    } catch (e) { setError(e.response?.data?.detail || 'Save failed') }
  }

  const setDLine = (i, k, v) => {
    const lines = [...dispatch.lines]
    lines[i] = { ...lines[i], [k]: v }
    setDispatch({ ...dispatch, lines })
  }

  const setDLineProduct = (i, id, manual) => {
    const lines = [...dispatch.lines]
    const p = id ? products.find((pp) => pp.id === id) : null
    lines[i] = {
      ...lines[i],
      product_id: id,
      description: id ? lines[i].description : (manual || ''),
      item_code: p ? (lines[i].item_code || p.item_code || '') : (lines[i].item_code || ''),
    }
    setDispatch({ ...dispatch, lines })
  }

  const delTransfer = async (tr) => {
    if (!confirm(`Delete transfer ${tr.transfer_no}? Stock movements will be reversed.`)) return
    try { await api.delete(`/inventory/transfers/${tr.id}`); loadTransfers(); loadStock(); loadInvIndex(); refreshCounts() }
    catch (e) { alert('Delete failed: ' + (e.response?.data?.detail || e.message)) }
  }

  // ---- table defs ----
  const transferColumns = [
    { key: 'transfer_no', label: 'Transfer No', render: (r) => <span className="font-mono text-xs font-medium">{r.transfer_no}</span> },
    { key: 'date', label: 'Date', render: (r) => r.transfer_date },
    { key: 'from', label: 'From', render: (r) => <Badge className="bg-cyan-50 text-cyan-700">{r.from_plant?.name || 'Main Store'}</Badge> },
    { key: 'to', label: 'To', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.to_plant?.name || '—'}</Badge> },
    { key: 'customer', label: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'lines', label: 'Lines', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.lines?.length || 0}</Badge> },
    {
      key: 'tracked', label: '',
      render: (r) => (r.warnings?.length
        ? <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 px-2 py-1 rounded-md" title={r.warnings.join(' ')}><AlertTriangle size={12} /> untracked</span>
        : null),
    },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => setDetail(r)} className="btn btn-ghost p-1.5" title="View"><Eye size={15} /></button>
          <button onClick={() => openEditTransfer(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => delTransfer(r)} className="btn btn-ghost p-1.5 text-red-400" title="Delete"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const historyColumns = [
    { key: 'date', label: 'Date', render: (r) => r.dispatch_date },
    { key: 'dispatch_no', label: 'Dispatch No', render: (r) => <span className="font-mono text-xs font-medium">{r.dispatch_no}</span> },
    { key: 'customer', label: 'Customer', render: (r) => r.customer || '—' },
    { key: 'product', label: 'Product', render: (r) => <span className="font-medium">{r.product || r.description}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'qty', label: 'Qty', render: (r) => <span className="font-semibold text-red-600">{fmtNum(r.quantity)}</span> },
    { key: 'location', label: 'Location', render: (r) => <Badge className="bg-purple-50 text-purple-700">{r.location}</Badge> },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <button onClick={() => openEditDispatch(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => delDispatch(r)} className="btn btn-ghost p-1.5 text-red-400" title="Delete dispatch"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const transferTabs = [
    { key: 'stock', label: 'Stock', icon: <Warehouse size={14} className="mr-1" />, count: items.length },
    { key: 'transfers', label: 'Transfers', icon: <ArrowLeftRight size={14} className="mr-1" />, count: transfersTotal },
    { key: 'dispatch', label: 'Dispatch History', icon: <History size={14} className="mr-1" />, count: historyTotal },
  ]

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Inventory" subtitle="Stock by location • Transfers between locations • Customer dispatch history"
        actions={
          <>
            {tab === 'stock' && <button onClick={() => downloadFile('/reports/inventory/csv', 'inventory.csv')} className="btn btn-secondary"><Download size={15} /> CSV</button>}
            {tab === 'stock' && <button onClick={openNewStock} className="btn btn-primary"><PackagePlus size={15} /> Add Stock</button>}
            {tab === 'transfers' && <button onClick={loadTransfers} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>}
            <button onClick={openNewTransfer} className="btn btn-secondary"><ArrowLeftRight size={15} /> Transfer Stock</button>
            <button onClick={openNewDispatch} className="btn btn-primary"><Truck size={15} /> New Dispatch</button>
          </>
        } />

      {tab === 'stock' && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard label="Stock Lines" value={items.length} icon={Package} iconClass="bg-amber-50 text-amber-600" />
          <StatCard label="Healthy" value={ok} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
          <StatCard label="Low Stock" value={low} icon={AlertTriangle} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
          <StatCard label="Out of Stock" value={out} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
        </div>
      )}

      <div className="mb-5">
        <PageTabs tabs={transferTabs} active={tab} onChange={setTab} />
      </div>

      {tab === 'stock' && (
        <Card subtitle={`Total stock on hand${plantId ? ` in ${locName(plantId)}` : ''}: ${fmtNum(totalStock)}`} actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search product…" className="input input-icon sm:w-56" />
            </div>
            <select value={plantId} onChange={(e) => setPlantId(e.target.value)} className="input">
              <option value="">All locations</option>
              {locations.map((l) => <option key={l.id ?? 'main'} value={l.id ?? ''}>{l.name}</option>)}
            </select>
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
          {loading ? <Loading /> : items.length === 0 ? <Empty /> : <Table columns={stockColumns} data={items} keyField="id" stickyColumns={['model']} dense />}
        </Card>
      )}

      {tab === 'transfers' && (
        <Card actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input value={transSearch} onChange={(e) => setTransSearch(e.target.value)} placeholder="Search transfer…" className="input input-icon sm:w-56" />
          </div>
        }>
          {transLoading ? <Loading /> : transfers.length === 0 ? <Empty text="No transfers yet — move stock with a Transfer Stock document" /> : <Table columns={transferColumns} data={transfers} keyField="id" stickyColumns={['transfer_no']} />}
        </Card>
      )}

      {tab === 'dispatch' && (
        <Card actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Search size={15} className="text-slate-400 pointer-events-none inline mr-1" />
            <select value={histCustomer} onChange={(e) => setHistCustomer(e.target.value)} className="input max-w-40">
              <option value="">All customers</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} className="input" />
            <span className="text-slate-400 text-xs">to</span>
            <input type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} className="input" />
            <button onClick={loadHistory} className="btn btn-secondary"><RefreshCw size={14} /> Refresh</button>
          </div>
        }>
          {histLoading ? <Loading /> : history.length === 0 ? <Empty text="No customer dispatches yet — use New Dispatch to record one" /> : <Table columns={historyColumns} data={history} keyField="line_id" stickyColumns={['dispatch_no']} />}
        </Card>
      )}

      {detail && (
        <Modal open title={`Transfer ${detail.transfer_no}`} onClose={() => setDetail(null)} wide
          footer={<button onClick={() => setDetail(null)} className="btn btn-secondary">Close</button>}>
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">From:</span> <span className="font-medium">{detail.from_plant?.name || 'Main Store'}</span></div>
            <div><span className="text-slate-500">To:</span> <span className="font-medium">{detail.to_plant?.name || '—'}</span></div>
            <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{detail.customer?.name || '—'}</span></div>
            <div><span className="text-slate-500">Date:</span> {detail.transfer_date}</div>
            {detail.notes && <div className="col-span-2"><span className="text-slate-500">Notes:</span> {detail.notes}</div>}
            {detail.warnings?.length > 0 && (
              <div className="col-span-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">
                <strong>Stock not updated:</strong> {detail.warnings.join(' ')}
              </div>
            )}
          </div>
          <Table columns={[
            { key: 'product', label: 'Product', render: (l) => <span className="font-medium">{l.product?.model || l.description}</span> },
            { key: 'item_code', label: 'Item Code', render: (l) => <span className="font-mono text-xs">{l.item_code || '—'}</span> },
            { key: 'qty', label: 'Qty', render: (l) => <span className="font-semibold">{fmtNum(l.quantity)}</span> },
          ]} data={detail.lines || []} />
        </Modal>
      )}

      {showTransferForm && (
        <StockTransferModal
          open={showTransferForm}
          onClose={() => { setShowTransferForm(false); setTransferInit(null) }}
          locations={locations}
          products={products}
          customers={customers}
          invIndex={invIndex}
          initial={transferInit}
          onSaved={afterTransferSaved}
        />
      )}

      {showDispatchForm && dispatch && (
        <Modal open title={dispatch.id ? `Edit Dispatch ${dispatch.dispatch_no}` : 'New Customer Dispatch'} onClose={() => setShowDispatchForm(false)} wide
          footer={<>
            <button onClick={() => setShowDispatchForm(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={saveDispatch} className="btn btn-primary">{dispatch.id ? 'Save Changes' : 'Record Dispatch'}</button>
          </>}>
          {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div><label className="block text-slate-500 text-xs mb-1">Dispatch No</label>
              <input value={dispatch.dispatch_no || ''} onChange={(e) => setDispatch({ ...dispatch, dispatch_no: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Dispatch Date</label>
              <input type="date" value={dispatch.dispatch_date} onChange={(e) => setDispatch({ ...dispatch, dispatch_date: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">From Location</label>
              <select value={dispatch.plant_id ?? ''} onChange={(e) => setDispatch({ ...dispatch, plant_id: e.target.value })} className="input">
                {dispOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div><label className="block text-slate-500 text-xs mb-1">Customer <span className="text-slate-400">(optional)</span></label>
              <SearchSelect
                options={customers.map((c) => ({ id: c.id, label: c.name }))}
                value={dispatch.customer_id || null}
                initialLabel={!dispatch.customer_id ? (dispatch.customer_name || '') : ''}
                placeholder="Type to search customer or enter a name"
                onChange={(id, manual) => setDispatch((f) => ({ ...f, customer_id: id, customer_name: manual }))}
              /></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Remarks</label>
              <input value={dispatch.remarks || ''} onChange={(e) => setDispatch({ ...dispatch, remarks: e.target.value })} className="input" /></div>
          </div>

          <div className="mb-1 text-xs font-medium text-slate-500 uppercase">Dispatch Lines</div>
          <div className="hidden sm:grid grid-cols-12 gap-2 items-center text-[10px] uppercase tracking-wide text-slate-400 mb-1 px-1">
            <div className="col-span-5">Product / Manual Item</div>
            <div className="col-span-2">Item Code</div>
            <div className="col-span-2">Available</div>
            <div className="col-span-2">Qty</div>
            <div className="col-span-1" />
          </div>
          <div className="space-y-2">
            {dispatch.lines.map((ln, i) => {
              const plantKey = dispatch.plant_id || ''
              const avail = ln.product_id ? (invIndex[`${Number(ln.product_id)}:${plantKey}`] ?? 0) : null
              return (
                <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
                  <SearchSelect
                    options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                    value={ln.product_id || null}
                    initialLabel={!ln.product_id ? (ln.description || '') : ''}
                    placeholder="Product or manual item…"
                    className="input col-span-5 py-1.5"
                    onChange={(id, manual) => setDLineProduct(i, id || '', manual)}
                  />
                  <input value={ln.item_code ?? ''} onChange={(e) => setDLine(i, 'item_code', e.target.value)} placeholder="e.g. LAP-001" className="input col-span-2 py-1.5" />
                  <span className="col-span-2 text-slate-400">{avail != null ? fmtNum(avail) : '—'}</span>
                  <input value={ln.quantity ?? ''} type="number" onChange={(e) => setDLine(i, 'quantity', e.target.value)} placeholder="Qty" className="input col-span-2 py-1.5" />
                  <button onClick={() => { if (dispatch.lines.length > 1) setDispatch({ ...dispatch, lines: dispatch.lines.filter((_, j) => j !== i) }) }} className="col-span-1 text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
                </div>
              )
            })}
          </div>
          <button onClick={() => setDispatch({ ...dispatch, lines: [...dispatch.lines, blankLine()] })} className="btn btn-ghost mt-2 text-xs"><Plus size={12} className="inline mr-1" />Add line</button>
        </Modal>
      )}

      {stockDetail && (
        <Modal open title={`Stock — ${stockDetail.product?.model || 'Unknown'}`} onClose={() => setStockDetail(null)} wide
          footer={<>
            <button onClick={() => setStockDetail(null)} className="btn btn-secondary">Close</button>
            <button onClick={() => { const row = stockDetail; setStockDetail(null); openEditStock(row) }} className="btn btn-primary"><Pencil size={14} /> Edit</button>
          </>}>
          <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
            <div><span className="text-slate-500">Product:</span> <span className="font-medium">{stockDetail.product?.model}</span></div>
            <div><span className="text-slate-500">Item Code:</span> <span className="font-mono">{stockDetail.product?.item_code || '—'}</span></div>
            <div><span className="text-slate-500">Category:</span> <span className="capitalize">{stockDetail.product?.category?.replace(/_/g, ' ')}</span></div>
            <div><span className="text-slate-500">Unit:</span> {stockDetail.product?.uom || '—'}</div>
            <div><span className="text-slate-500">Location:</span> {stockDetail.plant?.name || 'Main Store'}</div>
            <div><span className="text-slate-500">Status:</span> <Badge className={statusCls[stockDetail.status]}>{stockDetail.status.replace('_', ' ')}</Badge></div>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm mb-2">
            <div className="rounded-lg bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-slate-400">Opening</div><div className="font-semibold">{fmtNum(stockDetail.opening_stock)}</div></div>
            <div className="rounded-lg bg-green-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-green-600">Received</div><div className="font-semibold text-green-700">{fmtNum(stockDetail.received_qty)}</div></div>
            <div className="rounded-lg bg-red-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-red-600">Issued</div><div className="font-semibold text-red-700">{fmtNum(stockDetail.issued_qty)}</div></div>
            <div className="rounded-lg bg-amber-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-amber-600">Current Stock</div><div className="font-semibold text-amber-700">{fmtNum(stockDetail.current_stock)}</div></div>
          </div>
          <div className="text-xs text-slate-500">Min. Level: {stockDetail.min_level != null ? fmtNum(stockDetail.min_level) : '—'}</div>
        </Modal>
      )}

      {showStockModal && stockForm && (
        <Modal open title={stockForm.id ? `Edit Stock — ${stockForm.description || stockForm.item_code || 'inventory line'}` : 'Add Physical Stock'} onClose={() => setShowStockModal(false)} wide
          footer={<>
            <button onClick={() => setShowStockModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={saveStock} className="btn btn-primary">{stockForm.id ? 'Save Changes' : 'Add Stock'}</button>
          </>}>
          {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
          {!stockForm.id && (
            <div className="mb-3 text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
              Item Code is optional — physical stock is tracked by Product. A new description without a Product creates a fresh Product automatically.
            </div>
          )}
          {stockForm.id && (
            <div className="mb-3 text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
              Quantity is reconciled (500 → 700 becomes 700, never 1200). Item Code / Unit / Min Level update the same Product. Changing Product or Location is blocked unless the line is empty — use Transfer Stock to move stock between locations.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Product / Item {!stockForm.id && <span className="text-slate-400">(optional for manual)</span>}</label>
              <SearchSelect
                options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                value={stockForm.product_id || null}
                initialLabel={!stockForm.product_id ? (stockForm.description || '') : ''}
                placeholder="Search product or type a new item…"
                onChange={(id, manual) => setStockForm((f) => ({ ...f, product_id: id, description: id ? f.description || (products.find((pp) => pp.id === id)?.name || '') : (manual || '') }))}
              /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Item Code <span className="text-slate-400">(optional)</span></label>
              <input value={stockForm.item_code ?? ''} onChange={(e) => setStockForm({ ...stockForm, item_code: e.target.value })} placeholder="e.g. RM-001" className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Unit</label>
              <input value={stockForm.unit ?? ''} onChange={(e) => setStockForm({ ...stockForm, unit: e.target.value })} placeholder="KG" className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">{stockForm.id ? 'Current Stock' : 'Quantity'} *</label>
              <input value={stockForm.quantity ?? ''} type="number" min="0" onChange={(e) => setStockForm({ ...stockForm, quantity: e.target.value })} placeholder="0" className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Location</label>
              <select value={stockForm.plant_id ?? ''} onChange={(e) => setStockForm({ ...stockForm, plant_id: e.target.value })} className="input">
                <option value="">Main Store</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div><label className="block text-slate-500 text-xs mb-1">Date</label>
              <input type="date" value={stockForm.transaction_date || today()} onChange={(e) => setStockForm({ ...stockForm, transaction_date: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Min. Level</label>
              <input value={stockForm.min_level ?? ''} type="number" min="0" onChange={(e) => setStockForm({ ...stockForm, min_level: e.target.value })} placeholder="Optional" className="input" /></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Remarks / Reference</label>
              <input value={stockForm.remarks ?? ''} onChange={(e) => setStockForm({ ...stockForm, remarks: e.target.value })} placeholder="e.g. Physical GRN, Gate entry, Challan reference" className="input" /></div>
          </div>
        </Modal>
      )}
    </div>
  )
}