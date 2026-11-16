// Box-wise Production Records (weighing machine workflow) — Production page tabs.
// Covers: Production Records, Production Summary, Tare Weight Settings and
// Machine Integration. Machine communication is preparation-only; SIMULATION
// mode demonstrates the receiving workflow without claiming a real machine.
import { useEffect, useState } from 'react'
import {
  Plus, Pencil, RefreshCw, Trash2, Download, Search, Scale, PlugZap,
  FlaskConical, RotateCcw, AlertTriangle, CheckCircle2, Info, Settings,
} from 'lucide-react'
import api, { downloadFile } from '../lib/api'
import { Card, Modal, Loading, Empty, Badge, StatCard, SearchSelect } from './ui'
import Table from './Table'
import { fmtNum } from '../lib/format'
import { useAuth } from '../context/AuthContext'

const today = () => new Date().toISOString().slice(0, 10)
const fmtWt = (v) => (v == null ? '—' : `${fmtNum(v)} kg`)

const SYNC_CLASS = {
  SYNCED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-600',
}
const TXN_CLASS = {
  PROCESSED: 'bg-green-100 text-green-700',
  RECEIVED: 'bg-blue-100 text-blue-700',
  DUPLICATE: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-600',
}
const CONN_CLASS = {
  AWAITING_CONFIGURATION: 'bg-amber-100 text-amber-700',
  CONNECTED: 'bg-green-100 text-green-700',
  DISCONNECTED: 'bg-red-100 text-red-600',
}
const CONN_LABEL = {
  AWAITING_CONFIGURATION: 'Awaiting Configuration',
  CONNECTED: 'Connected',
  DISCONNECTED: 'Disconnected',
}

export function SyncBadge({ status }) {
  return <Badge className={SYNC_CLASS[status] || 'bg-slate-100 text-slate-600'} dot>{status || '—'}</Badge>
}

export function RecordStatusBadge({ status }) {
  if (status === 'READY') return <Badge className="bg-green-100 text-green-700" dot>Ready</Badge>
  return <Badge className="bg-amber-100 text-amber-700" dot>Tare Missing</Badge>
}

const EMPTY_FILTERS = { search: '', product_id: '', size: '', grade: '', date_from: '', date_to: '', sync_status: '' }
const filterParams = (f) => ({
  search: f.search || undefined,
  product_id: f.product_id || undefined,
  size: f.size || undefined,
  grade: f.grade || undefined,
  date_from: f.date_from || undefined,
  date_to: f.date_to || undefined,
  sync_status: f.sync_status || undefined,
})

// ---------------------------------------------------------------------------
// 1. Production Records (box-wise)
// ---------------------------------------------------------------------------
export function ProductionRecordsTab({ products }) {
  const { user } = useAuth()
  const canManage = ['admin', 'manager'].includes(user?.role)
  const canWrite = user?.role && user.role !== 'viewer'

  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [sizes, setSizes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState(EMPTY_FILTERS)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    setError('')
    const params = { ...filterParams(filters), page_size: 500 }
    return Promise.all([
      api.get('/production/records', { params }),
      api.get('/production/records/summary', { params }),
    ])
      .then(([r, s]) => { setItems(r.data.items || []); setTotal(r.data.total || 0); setSummary(s.data) })
      .catch((e) => { setError(e.response?.data?.detail || e.message); setItems([]) })
      .finally(() => setLoading(false))
  }
  const loadSizes = () => api.get('/production/records/sizes')
    .then((r) => setSizes(r.data.items || [])).catch(() => {})

  useEffect(() => { loadSizes() }, [])
  useEffect(() => { load() }, [filters])

  const openNew = () => {
    setForm({ production_date: today(), gross_weight: '', box_number: '', barcode: '', size: '', grade: '', micron: '', remark: '', product_id: null, product: '' })
    setFormError('')
    setShowForm(true)
  }

  const saveRecord = async () => {
    setFormError('')
    if (!form.size?.trim()) { setFormError('Size is required (used to find the Tare Weight).'); return }
    if (!String(form.box_number || '').trim()) { setFormError('Box Number is required.'); return }
    const gross = Number(form.gross_weight)
    if (!gross || gross <= 0) { setFormError('Gross Weight must be greater than 0.'); return }
    setSaving(true)
    try {
      await api.post('/production/records', {
        product_id: form.product_id || null,
        product: form.product || '',
        item_code: form.item_code || '',
        size: form.size.trim(),
        grade: form.grade || '',
        micron: form.micron || '',
        production_date: form.production_date || today(),
        box_number: String(form.box_number).trim(),
        barcode: form.barcode?.trim() || null,
        gross_weight: gross,
        remark: form.remark || '',
      })
      setShowForm(false)
      setForm({})
      load(); loadSizes()
    } catch (e) {
      setFormError(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  const retrySync = (r) => {
    api.post(`/production/records/${r.id}/retry-sync`)
      .then((res) => {
        if (res.data.inventory_sync_status !== 'SYNCED') {
          alert(res.data.inventory_sync_error || 'Record is still not synced. Check Tare Weight Settings.')
        }
        load()
      })
      .catch((e) => alert('Retry failed: ' + (e.response?.data?.detail || e.message)))
  }

  const removeRecord = (r) => {
    if (!window.confirm(`Delete production record for Box ${r.box_number} (${r.product_name}, ${r.size})?${r.inventory_sync_status === 'SYNCED' ? ' Its stock movement will be reversed.' : ''}`)) return
    api.delete(`/production/records/${r.id}`)
      .then(() => load())
      .catch((e) => alert('Delete failed: ' + (e.response?.data?.detail || e.message)))
  }

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }))
  const hasFilters = filters.search || filters.product_id || filters.size || filters.date_from || filters.date_to || filters.sync_status
  const activeFilterCount = [filters.search, filters.product_id, filters.size, filters.date_from, filters.date_to, filters.sync_status].filter(Boolean).length

  const cols = [
    { key: 'production_date', label: 'Date', render: (r) => r.production_date || '—' },
    { key: 'box_number', label: 'Box No', render: (r) => <span className="font-semibold tabular-nums">{r.box_number}</span> },
    { key: 'barcode', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.barcode || '—'}</span> },
    { key: 'product_name', label: 'Product', render: (r) => <span className="font-medium">{r.product?.model || r.product_name || '—'}</span> },
    { key: 'size', label: 'Size', render: (r) => r.size || '—' },
    { key: 'grade', label: 'Grade', render: (r) => r.grade || '—' },
    { key: 'micron', label: 'Micron', render: (r) => r.micron || '—' },
    { key: 'gross_weight', label: 'Gross', render: (r) => <span className="tabular-nums">{fmtWt(r.gross_weight)}</span> },
    { key: 'tare_weight', label: 'Tare', render: (r) => <span className="tabular-nums">{fmtWt(r.tare_weight)}</span> },
    { key: 'net_weight', label: 'Net', render: (r) => <span className="font-semibold text-green-700 tabular-nums">{fmtWt(r.net_weight)}</span> },
    { key: 'record_status', label: 'Record', render: (r) => <RecordStatusBadge status={r.record_status} /> },
    { key: 'inventory_sync_status', label: 'Inv. Sync', render: (r) => (
      <span title={r.inventory_sync_error || ''}><SyncBadge status={r.inventory_sync_status} /></span>
    )},
    { key: 'source', label: 'Source', render: (r) => <span className="text-xs text-slate-500">{r.source === 'SIMULATION' ? 'Simulation' : r.source === 'MANUAL' ? 'Manual' : r.source === 'MACHINE_API' ? 'Machine' : '—'}</span> },
    { key: 'remark', label: 'Remark', render: (r) => <span className="text-slate-500 text-xs max-w-[14rem] truncate block" title={r.remark || ''}>{r.remark || '—'}</span> },
    { key: 'actions', label: '', render: (r) => (
      <div className="flex items-center gap-0.5">
        {r.inventory_sync_status !== 'SYNCED' && canWrite && (
          <button onClick={(e) => { e.stopPropagation(); retrySync(r) }} className="text-slate-400 hover:text-blue-600 p-1 hover:bg-blue-50 rounded" title={r.inventory_sync_error || 'Retry inventory sync'}><RotateCcw size={14} /></button>
        )}
        {canManage && (
          <button onClick={(e) => { e.stopPropagation(); removeRecord(r) }} className="text-slate-400 hover:text-red-600 p-1 hover:bg-red-50 rounded" title="Delete (reverses stock)"><Trash2 size={14} /></button>
        )}
      </div>
    )},
  ]

  return (
    <div className="space-y-4">
      {/* Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Boxes" value={summary ? fmtNum(summary.total_boxes) : '—'} icon={Scale} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Total Gross Weight" value={summary ? fmtWt(summary.total_gross_weight) : '—'} icon={Scale} iconClass="bg-slate-100 text-slate-600" />
        <StatCard label="Total Tare Weight" value={summary ? fmtWt(summary.total_tare_weight) : '—'} icon={Scale} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Total Net Weight" value={summary ? fmtWt(summary.total_net_weight) : '—'} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
      </div>

      {/* Sync / attention status */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-green-200 bg-green-50/70 px-4 py-3">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-green-700">Synced</div>
          <div className="text-xl font-bold text-green-700 tabular-nums mt-0.5">{summary ? fmtNum(summary.synced) : '—'}</div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-amber-700">Pending Sync</div>
          <div className="text-xl font-bold text-amber-700 tabular-nums mt-0.5">{summary ? fmtNum(summary.sync_pending) : '—'}</div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50/70 px-4 py-3">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-red-700">Sync Failed</div>
          <div className="text-xl font-bold text-red-700 tabular-nums mt-0.5">{summary ? fmtNum(summary.sync_failed) : '—'}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-600">Tare Missing</div>
          <div className="text-xl font-bold text-slate-700 tabular-nums mt-0.5">{summary ? fmtNum(summary.tare_missing) : '—'}</div>
        </div>
      </div>

      {summary && (summary.tare_missing > 0 || summary.sync_failed > 0) && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2.5 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 mt-0.5" />
          <span>
            {summary.tare_missing > 0 && <><b>{summary.tare_missing}</b> record(s) missing tare (net not calculated). Configure in <b>Tare Weight Settings</b>, then Retry Sync. </>}
            {summary.sync_failed > 0 && <><b>{summary.sync_failed}</b> record(s) failed inventory posting — use Retry Sync.</>}
          </span>
        </div>
      )}

      <Card title="Box-wise Production Records" subtitle="Permanent packing records from weighing machine, simulation, or manual entry"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => downloadFile(`/production/records/report/csv${buildQuery(filters)}`, 'production_records.csv')} className="btn btn-secondary"><Download size={15} /> Export CSV</button>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            {canWrite && <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> New Record</button>}
          </div>
        }>
        {/* Filters */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Filters</div>
            <div className="flex items-center gap-2">
              {hasFilters && <span className="text-xs text-slate-500">{activeFilterCount} active</span>}
              {hasFilters && <button onClick={() => setFilters(EMPTY_FILTERS)} className="btn btn-secondary btn-sm">Clear all</button>}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <div className="xl:col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Search</label>
              <div className="relative flex items-center">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" />
                <input value={filters.search} onChange={(e) => setFilter({ search: e.target.value })} placeholder="Box no, barcode, product…" className="input w-full placeholder:text-slate-400" style={{ paddingLeft: '2.5rem' }} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Product</label>
              <select value={filters.product_id} onChange={(e) => setFilter({ product_id: e.target.value ? Number(e.target.value) : '' })} className="input w-full">
                <option value="">All products</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Size</label>
              <select value={filters.size} onChange={(e) => setFilter({ size: e.target.value })} className="input w-full">
                <option value="">All sizes</option>
                {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Sync Status</label>
              <select value={filters.sync_status} onChange={(e) => setFilter({ sync_status: e.target.value })} className="input w-full">
                <option value="">All</option>
                <option value="SYNCED">Synced</option>
                <option value="PENDING">Pending</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>
            <div className="xl:col-span-1 sm:col-span-2 lg:col-span-3 xl:col-span-6">
              <label className="block text-xs text-slate-500 mb-1">Production Date Range</label>
              <div className="flex items-center gap-2 flex-wrap">
                <input type="date" value={filters.date_from} onChange={(e) => setFilter({ date_from: e.target.value })} className="input w-44" />
                <span className="text-slate-400 text-xs">to</span>
                <input type="date" value={filters.date_to} onChange={(e) => setFilter({ date_to: e.target.value })} className="input w-44" />
              </div>
            </div>
          </div>
        </div>

        {/* Records table */}
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-slate-700">Records</div>
          <div className="text-xs text-slate-500">{loading ? 'Loading…' : `Showing ${items.length} of ${total} record(s)`}</div>
        </div>
        {loading ? <Loading /> : error ? <Empty text={error} /> : items.length === 0
          ? <Empty text={hasFilters ? 'No records match the current filters.' : 'No production records yet — records arrive from the weighing machine, simulation or manual entry.'} />
          : <Table columns={cols} data={items} keyField="id" stickyColumns={['product_name']} />}
      </Card>

      {/* Manual record entry modal */}
      <Modal open={showForm} title="New Production Record" subtitle="Manual box entry — validated and synced exactly like machine data"
        onClose={() => setShowForm(false)} wide
        footer={<>
          <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={saveRecord} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save Record'}</button>
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {formError && (
            <div className="sm:col-span-2 rounded-lg bg-red-50 border border-red-200 text-red-700 px-3 py-2 text-xs">{formError}</div>
          )}
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Product <span className="text-red-500">*</span></label>
            <SearchSelect
              options={products.map((p) => ({ id: p.id, label: p.model }))}
              value={form.product_id}
              initialLabel={!form.product_id ? (form.product || '') : ''}
              placeholder="Type to search or enter a product name"
              onChange={(id, manual) => {
                if (id) {
                  const mm = products.find((p) => p.id === id)
                  setForm((f) => ({ ...f, product_id: id, product: mm?.model || '', item_code: mm?.item_code || f.item_code || '' }))
                } else {
                  setForm((f) => ({ ...f, product_id: null, product: manual }))
                }
              }}
            /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Size <span className="text-red-500">*</span></label>
            <SearchSelect
              options={sizes.map((s) => ({ id: s, label: s }))}
              value={form.size}
              placeholder="e.g. 400mm — picks the Tare Weight"
              onChange={(id, manual) => setForm((f) => ({ ...f, size: id || manual }))}
            /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Grade</label>
            <input value={form.grade || ''} onChange={(e) => setForm({ ...form, grade: e.target.value })} className="input" placeholder="e.g. Higher" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Micron</label>
            <input value={form.micron || ''} onChange={(e) => setForm({ ...form, micron: e.target.value })} className="input" placeholder="e.g. 4500" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Production Date</label>
            <input type="date" value={form.production_date || today()} onChange={(e) => setForm({ ...form, production_date: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Box Number <span className="text-red-500">*</span></label>
            <input value={form.box_number || ''} onChange={(e) => setForm({ ...form, box_number: e.target.value })} className="input" placeholder="e.g. 1" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Barcode</label>
            <input value={form.barcode || ''} onChange={(e) => setForm({ ...form, barcode: e.target.value })} className="input" placeholder="Unique box barcode (optional)" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Gross Weight (kg) <span className="text-red-500">*</span></label>
            <input type="number" min="0" step="0.001" value={form.gross_weight ?? ''} onChange={(e) => setForm({ ...form, gross_weight: e.target.value })} className="input" placeholder="e.g. 26.500" /></div>
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Remark</label>
            <textarea value={form.remark || ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} className="input" rows={2} /></div>
          <div className="sm:col-span-2 text-xs text-slate-400">
            Net Weight = Gross Weight − Tare Weight (from Tare Weight Settings for the Size). Only Net Weight is posted to Finished Goods stock, exactly once per box.
          </div>
        </div>
      </Modal>
    </div>
  )
}

function buildQuery(f) {
  const p = filterParams(f)
  const qs = Object.entries(p).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return qs ? `?${qs}` : ''
}

// ---------------------------------------------------------------------------
// 2. Production Summary (size-wise + date-wise, box-wise records)
// ---------------------------------------------------------------------------
export function ProductionSummaryTab({ products }) {
  const [items, setItems] = useState([])
  const [totals, setTotals] = useState(null)
  const [daily, setDaily] = useState([])
  const [dailyTotals, setDailyTotals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [productId, setProductId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [reportMonth, setReportMonth] = useState(today().slice(0, 7))

  const params = {
    product_id: productId || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }
  const load = () => {
    setLoading(true)
    return Promise.all([
      api.get('/production/records/size-summary', { params }),
      api.get('/production/records/daily-summary', { params }),
    ])
      .then(([s, d]) => {
        setItems(s.data.items || []); setTotals(s.data.totals || null)
        setDaily(d.data.items || []); setDailyTotals(d.data.totals || null)
      })
      .catch(() => { setItems([]); setTotals(null); setDaily([]); setDailyTotals(null) })
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [productId, dateFrom, dateTo])

  const sizeCols = [
    { key: 'size', label: 'Size', render: (r) => <span className="font-medium">{r.size}</span> },
    { key: 'total_boxes', label: 'Total Boxes', render: (r) => <span className="font-semibold tabular-nums">{fmtNum(r.total_boxes)}</span> },
    { key: 'total_gross_weight', label: 'Gross Weight', render: (r) => <span className="tabular-nums">{fmtWt(r.total_gross_weight)}</span> },
    { key: 'total_tare_weight', label: 'Tare Weight', render: (r) => <span className="tabular-nums">{fmtWt(r.total_tare_weight)}</span> },
    { key: 'total_net_weight', label: 'Net Weight', render: (r) => <span className="font-semibold text-green-700 tabular-nums">{fmtWt(r.total_net_weight)}</span> },
  ]
  const dailyCols = [
    { key: 'production_date', label: 'Production Date', render: (r) => <span className="font-medium">{r.production_date}</span> },
    { key: 'total_boxes', label: 'Total Boxes', render: (r) => <span className="font-semibold tabular-nums">{fmtNum(r.total_boxes)}</span> },
    { key: 'total_gross_weight', label: 'Gross Weight', render: (r) => <span className="tabular-nums">{fmtWt(r.total_gross_weight)}</span> },
    { key: 'total_tare_weight', label: 'Tare Weight', render: (r) => <span className="tabular-nums">{fmtWt(r.total_tare_weight)}</span> },
    { key: 'total_net_weight', label: 'Net Weight', render: (r) => <span className="font-semibold text-green-700 tabular-nums">{fmtWt(r.total_net_weight)}</span> },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Boxes" value={totals ? fmtNum(totals.total_boxes) : '—'} icon={Scale} iconClass="bg-violet-50 text-violet-600" />
        <StatCard label="Total Gross" value={totals ? fmtWt(totals.total_gross_weight) : '—'} icon={Scale} iconClass="bg-slate-100 text-slate-600" />
        <StatCard label="Total Net Weight" value={totals ? fmtWt(totals.total_net_weight) : '—'} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Production Days" value={dailyTotals ? fmtNum(dailyTotals.days) : '—'} icon={CheckCircle2} iconClass="bg-blue-50 text-blue-600" />
      </div>
      <Card title="Production Summary" subtitle="Box-wise production totals by size and by date"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')} className="input w-48">
              <option value="">All products</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.model}</option>)}
            </select>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input w-40" title="From date" />
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input w-40" title="To date" />
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
          </div>
        }>
        {loading ? <Loading /> : items.length === 0
          ? <Empty text="No production records for the selected filters" />
          : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Size-wise Totals</div>
                <Table columns={sizeCols} data={items} keyField="size" dense />
                {totals && (
                  <div className="flex justify-end gap-5 mt-2 text-xs font-semibold text-slate-600">
                    <span>Boxes: <span className="tabular-nums">{fmtNum(totals.total_boxes)}</span></span>
                    <span className="text-green-700">Net: <span className="tabular-nums">{fmtWt(totals.total_net_weight)}</span></span>
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Date-wise Totals</div>
                <Table columns={dailyCols} data={daily} keyField="production_date" dense />
                {dailyTotals && (
                  <div className="flex justify-end gap-5 mt-2 text-xs font-semibold text-slate-600">
                    <span>Days: <span className="tabular-nums">{fmtNum(dailyTotals.days)}</span></span>
                    <span>Boxes: <span className="tabular-nums">{fmtNum(dailyTotals.total_boxes)}</span></span>
                    <span className="text-green-700">Net: <span className="tabular-nums">{fmtWt(dailyTotals.total_net_weight)}</span></span>
                  </div>
                )}
              </div>
            </div>
          )}
      </Card>

      {/* Legacy movement-based monthly report export (data source unchanged —
          the same report also lives under Reports → Production). */}
      <Card title="Monthly Production Movement Report" subtitle="Quantity-based monthly report from production movements (existing report, export only)">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <input type="month" value={reportMonth} onChange={(e) => setReportMonth(e.target.value)} className="input w-40" />
          <button onClick={() => downloadFile(reportMonth ? `/reports/production/monthly/csv?month=${reportMonth}` : '/reports/production/monthly/csv', 'monthly_production.csv')} className="btn btn-secondary"><Download size={15} /> Download CSV</button>
          <span className="text-xs text-slate-400">Full visual report is available under Reports → Production.</span>
        </div>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Tare Weight Settings
// ---------------------------------------------------------------------------
export function TareWeightSettingsTab() {
  const { user } = useAuth()
  const canManage = ['admin', 'manager'].includes(user?.role)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({})
  const [formError, setFormError] = useState('')

  const load = () => {
    setLoading(true)
    return api.get('/production/settings/tare-weights')
      .then((r) => setItems(r.data.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    setFormError('')
    if (!form.size?.trim()) { setFormError('Size is required.'); return }
    const tw = Number(form.tare_weight)
    if (!tw || tw <= 0) { setFormError('Tare Weight must be greater than 0.'); return }
    try {
      if (form.id) {
        await api.patch(`/production/settings/tare-weights/${form.id}`, {
          size: form.size.trim(), tare_weight: tw, uom: form.uom || 'kg', notes: form.notes || '',
        })
      } else {
        await api.post('/production/settings/tare-weights', {
          size: form.size.trim(), tare_weight: tw, uom: form.uom || 'kg', notes: form.notes || '',
        })
      }
      setShowForm(false); setForm({})
      load()
    } catch (e) {
      setFormError(e.response?.data?.detail || e.message)
    }
  }

  const remove = (r) => {
    if (!window.confirm(`Delete tare weight setting for size "${r.size}"? Existing production records keep their stored tare value.`)) return
    api.delete(`/production/settings/tare-weights/${r.id}`)
      .then(() => load())
      .catch((e) => alert('Delete failed: ' + (e.response?.data?.detail || e.message)))
  }

  const cols = [
    { key: 'size', label: 'Size', render: (r) => <span className="font-medium">{r.size}</span> },
    { key: 'tare_weight', label: 'Tare Weight', render: (r) => <span className="font-semibold tabular-nums">{fmtNum(r.tare_weight)} {r.uom}</span> },
    { key: 'is_active', label: 'Status', render: (r) => <Badge className={r.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'} dot>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'notes', label: 'Notes', render: (r) => <span className="text-slate-500 text-xs">{r.notes || '—'}</span> },
    { key: 'updated_by', label: 'Updated By', render: (r) => <span className="text-xs text-slate-500">{r.updated_by || '—'}</span> },
    ...(canManage ? [{ key: 'actions', label: '', render: (r) => (
      <div className="flex items-center gap-0.5">
        <button onClick={() => { setForm({ id: r.id, size: r.size, tare_weight: r.tare_weight, uom: r.uom, notes: r.notes }); setFormError(''); setShowForm(true) }} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="Edit"><Pencil size={15} /></button>
        <button onClick={() => remove(r)} className="text-slate-400 hover:text-red-600 p-1 hover:bg-red-50 rounded" title="Delete"><Trash2 size={14} /></button>
      </div>
    )}] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2.5 text-sm flex items-start gap-2">
        <Info size={16} className="mt-0.5 shrink-0" />
        <span>
          Configure the Less/Tare Weight once per Size. When a weighing transaction arrives, the ERP finds the tare for that Size and calculates
          <b> Net Weight = Gross Weight − Tare Weight</b>. The applied tare is stored on every production record, so changing these values never alters historical records.
        </span>
      </div>
      <Card title="Tare Weight Settings" subtitle="One tare weight per size — used for Net Weight calculation"
        actions={canManage ? <button onClick={() => { setForm({ uom: 'kg' }); setFormError(''); setShowForm(true) }} className="btn btn-primary"><Plus size={15} /> Add Tare Weight</button> : null}>
        {loading ? <Loading /> : items.length === 0
          ? <Empty text="No tare weights configured yet — records received for unconfigured sizes are flagged as Tare Missing" />
          : <Table columns={cols} data={items} keyField="id" />}
      </Card>

      <Modal open={showForm} title={form.id ? 'Edit Tare Weight' : 'Add Tare Weight'} subtitle="Sample only — enter the actual values provided by production"
        onClose={() => setShowForm(false)}
        footer={<>
          <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={save} className="btn btn-primary">Save</button>
        </>}>
        <div className="grid grid-cols-1 gap-3 text-sm">
          {formError && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 px-3 py-2 text-xs">{formError}</div>}
          <div><label className="block text-slate-500 text-xs mb-1">Size <span className="text-red-500">*</span></label>
            <input value={form.size || ''} onChange={(e) => setForm({ ...form, size: e.target.value })} className="input" placeholder="e.g. 400mm" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Tare Weight (kg) <span className="text-red-500">*</span></label>
            <input type="number" min="0" step="0.001" value={form.tare_weight ?? ''} onChange={(e) => setForm({ ...form, tare_weight: e.target.value })} className="input" placeholder="e.g. 5" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">UOM</label>
            <input value={form.uom || 'kg'} onChange={(e) => setForm({ ...form, uom: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Notes</label>
            <textarea value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" rows={2} /></div>
        </div>
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Machine Integration (preparation only)
// ---------------------------------------------------------------------------
const CONFIG_FIELD_LABELS = {
  com_port: 'COM Port', baud_rate: 'Baud Rate', data_bits: 'Data Bits',
  parity: 'Parity', stop_bits: 'Stop Bits', ip_address: 'IP Address',
  tcp_port: 'TCP Port', api_endpoint: 'API Endpoint', api_key_ref: 'API Key Reference',
  poll_interval_seconds: 'Poll Interval (seconds)',
}

export function MachineIntegrationTab() {
  const { user } = useAuth()
  const canManage = ['admin', 'manager'].includes(user?.role)
  const canWrite = user?.role && user.role !== 'viewer'

  const [status, setStatus] = useState(null)
  const [txns, setTxns] = useState([])
  const [txnTotal, setTxnTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState(null)
  const [configMsg, setConfigMsg] = useState('')
  const [simBusy, setSimBusy] = useState(false)
  const [simResult, setSimResult] = useState(null)

  const load = () => {
    setLoading(true)
    return Promise.all([
      api.get('/production/machine/status'),
      api.get('/production/machine/transactions', { params: { page_size: 10 } }),
    ])
      .then(([s, t]) => {
        setStatus(s.data)
        setTxns(t.data.items || [])
        setTxnTotal(t.data.total || 0)
        const c = s.data.connection
        setConfig((prev) => prev && prev._dirty ? prev : { name: c.name, connection_type: c.connection_type, config: c.config || {}, notes: c.notes || '' })
      })
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const saveConfig = async () => {
    setConfigMsg('')
    try {
      const payload = { name: config.name, connection_type: config.connection_type, config: config.config || {}, notes: config.notes || '' }
      await api.put('/production/machine/config', payload)
      setConfig({ ...payload, _dirty: false })
      setConfigMsg('Configuration saved. No connection is opened — the transport activates after the technician provides the machine details.')
      load()
    } catch (e) {
      setConfigMsg(e.response?.data?.detail || e.message)
    }
  }

  const runSimulation = async () => {
    setSimBusy(true)
    setSimResult(null)
    try {
      const r = await api.post('/production/machine/simulate')
      setSimResult(r.data)
      load()
    } catch (e) {
      setSimResult({ status: 'FAILED', error: e.response?.data?.detail || e.message })
    } finally {
      setSimBusy(false)
    }
  }

  const conn = status?.connection
  const counters = status?.counters || {}
  const placeholders = conn?.config_placeholders || []

  const txnCols = [
    { key: 'received_at', label: 'Received', render: (r) => <span className="text-xs tabular-nums">{r.received_at ? new Date(r.received_at).toLocaleString() : '—'}</span> },
    { key: 'transaction_uid', label: 'Transaction ID', render: (r) => <span className="font-mono text-xs">{r.transaction_uid}</span> },
    { key: 'source', label: 'Source', render: (r) => <span className="text-xs">{r.source === 'SIMULATION' ? 'Simulation' : r.source === 'MANUAL' ? 'Manual' : 'Machine'}</span> },
    { key: 'box_number', label: 'Box', render: (r) => r.box_number || '—' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={TXN_CLASS[r.status] || 'bg-slate-100 text-slate-600'} dot>{r.status}</Badge> },
    { key: 'error_message', label: 'Error / Note', render: (r) => <span className="text-xs text-slate-500">{r.error_message || (r.duplicate_count ? `Repeated ${r.duplicate_count}×` : '—')}</span> },
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2.5 text-sm flex items-start gap-2">
        <Info size={16} className="mt-0.5 shrink-0" />
        <span>{status?.integration_note || 'Preparation only — the weighing machine keeps working independently (data entry, weighing, printing). The ERP only receives the weighing transactions.'}</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Received Today" value={counters.received_today ?? '—'} icon={PlugZap} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Processed" value={counters.processed ?? '—'} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" />
        <StatCard label="Duplicates" value={counters.duplicate ?? '—'} icon={RotateCcw} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Failed" value={counters.failed ?? '—'} icon={AlertTriangle} iconClass="bg-red-50 text-red-600" valueClass={counters.failed ? 'text-red-600' : ''} />
      </div>

      {loading ? <Loading /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Connection status */}
          <Card title="Machine Connection" subtitle="Integration status — no live communication yet">
            {conn ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-slate-800">{conn.name}</div>
                    <div className="text-xs text-slate-500">Type: {conn.connection_type}</div>
                  </div>
                  <Badge className={CONN_CLASS[conn.status] || 'bg-slate-100 text-slate-600'} dot>{CONN_LABEL[conn.status] || conn.status}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-slate-500 block">Last activity</span><span className="font-medium">{conn.last_seen_at ? new Date(conn.last_seen_at).toLocaleString() : '—'}</span></div>
                  <div><span className="text-slate-500 block">Last error</span><span className="font-medium text-red-600">{conn.last_error || '—'}</span></div>
                </div>
                {status?.last_transaction && (
                  <div className="border rounded-lg p-3 bg-slate-50">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Last received transaction</div>
                    <div className="text-xs space-y-0.5">
                      <div><span className="text-slate-500">ID:</span> <span className="font-mono">{status.last_transaction.transaction_uid}</span></div>
                      <div><span className="text-slate-500">Box:</span> {status.last_transaction.box_number || '—'} · <span className="text-slate-500">Status:</span> {status.last_transaction.status}</div>
                      <div><span className="text-slate-500">At:</span> {new Date(status.last_transaction.received_at).toLocaleString()}</div>
                    </div>
                  </div>
                )}
                {status?.last_record && (
                  <div className="border rounded-lg p-3 bg-green-50/50">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Last production record</div>
                    <div className="text-xs space-y-0.5">
                      <div><span className="font-medium">{status.last_record.product_name}</span> · Box {status.last_record.box_number} · {status.last_record.size}</div>
                      <div>Gross {fmtWt(status.last_record.gross_weight)} → Net <b className="text-green-700">{fmtWt(status.last_record.net_weight)}</b> · <SyncBadge status={status.last_record.inventory_sync_status} /></div>
                    </div>
                  </div>
                )}
              </div>
            ) : <Empty text="Connection status unavailable" />}
          </Card>

          {/* Configuration */}
          <Card title="Connection Configuration" subtitle="Placeholders only — filled in with the machine technician"
            actions={!canManage ? <span className="text-xs text-slate-400">Manager/Admin only</span> : null}>
            {config ? (
              <div className="space-y-3 text-sm">
                <div><label className="block text-slate-500 text-xs mb-1">Connection Name</label>
                  <input value={config.name || ''} disabled={!canManage} onChange={(e) => setConfig({ ...config, name: e.target.value, _dirty: true })} className="input disabled:bg-slate-50" /></div>
                <div><label className="block text-slate-500 text-xs mb-1">Connection Type</label>
                  <select value={config.connection_type || 'NONE'} disabled={!canManage}
                    onChange={(e) => setConfig({ ...config, connection_type: e.target.value, config: {}, _dirty: true })}
                    className="input disabled:bg-slate-50">
                    {(conn?.connection_types || []).map((t) => <option key={t} value={t}>{t === 'NONE' ? 'None (not configured)' : t === 'SIMULATION' ? 'Simulation (demo mode)' : t.replace('_', ' ')}</option>)}
                  </select></div>
                {placeholders.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {placeholders.map((key) => (
                      <div key={key}>
                        <label className="block text-slate-500 text-xs mb-1">{CONFIG_FIELD_LABELS[key] || key}</label>
                        <input value={(config.config || {})[key] || ''} disabled={!canManage}
                          onChange={(e) => setConfig({ ...config, config: { ...(config.config || {}), [key]: e.target.value }, _dirty: true })}
                          className="input disabled:bg-slate-50" placeholder="Provided by technician" />
                      </div>
                    ))}
                  </div>
                )}
                <div><label className="block text-slate-500 text-xs mb-1">Notes</label>
                  <textarea value={config.notes || ''} disabled={!canManage} onChange={(e) => setConfig({ ...config, notes: e.target.value, _dirty: true })} className="input disabled:bg-slate-50" rows={2} placeholder="Machine model, protocol notes, technician contact…" /></div>
                {canManage && <button onClick={saveConfig} className="btn btn-primary"><Settings size={15} /> Save Configuration</button>}
                {configMsg && <div className="rounded-lg bg-slate-50 border border-slate-200 text-slate-600 px-3 py-2 text-xs">{configMsg}</div>}
              </div>
            ) : <Loading />}
          </Card>
        </div>
      )}

      {/* Simulation */}
      <Card title="Simulation Mode" subtitle="Demonstrates the ERP receiving workflow — clearly labelled, no real machine connected"
        actions={canWrite ? (
          <button onClick={runSimulation} disabled={simBusy} className="btn btn-secondary">
            <FlaskConical size={15} /> {simBusy ? 'Running…' : 'Simulate Weighing Transaction'}
          </button>
        ) : null}>
        <div className="text-sm text-slate-600 space-y-2">
          <p className="text-xs text-slate-500">
            Runs one sample packing-slip transaction (Product / Box No / Grade / Size / Micron / Date / Gross Weight / Barcode) through the real receiving pipeline:
            validation → duplicate check → tare lookup → Net Weight → production record → inventory sync. Configure a Tare Weight for size <b>400mm</b> first to see a complete sync.
          </p>
          {simResult && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${simResult.status === 'PROCESSED' ? 'bg-green-50 border-green-200 text-green-700' : simResult.status === 'DUPLICATE' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
              <b>SIMULATION — {simResult.status}</b>
              {simResult.record && <> · Box {simResult.record.box_number}, {simResult.record.product_name} {simResult.record.size}, Gross {fmtWt(simResult.record.gross_weight)}, Net {fmtWt(simResult.record.net_weight)}, Sync {simResult.record.inventory_sync_status}</>}
              {simResult.error && <> · {simResult.error}</>}
            </div>
          )}
        </div>
      </Card>

      {/* Integration inbox / error log */}
      <Card title="Received Transactions" subtitle={`Integration inbox and error log — ${txnTotal} transaction(s)`}
        actions={<button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>}>
        {loading ? <Loading /> : txns.length === 0
          ? <Empty text="No transactions received yet — use Simulation Mode to demonstrate the workflow" />
          : <Table columns={txnCols} data={txns} keyField="id" dense />}
      </Card>

      <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600">
        <b>Still required from the machine technician:</b> machine make &amp; model, communication protocol (RS232 / USB Serial / TCP-IP / vendor API-SDK),
        port details (COM port, baud rate, data bits, parity, stop bits — or IP address + TCP port), the exact data format sent per weighing
        (field order, delimiters, encoding, sample payload) and whether the machine provides a unique Transaction ID.
      </div>
    </div>
  )
}
