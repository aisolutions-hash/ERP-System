import { useEffect, useMemo, useState } from 'react'
import {
  Plus, Search, Download, Upload, Eye, Pencil, ArrowUpDown, Ruler,
  ChevronLeft, ChevronRight, FileSpreadsheet, CheckCircle2, AlertTriangle, Power,
} from 'lucide-react'
import api, { downloadFile } from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, SearchSelect } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const PAGE_SIZES = [10, 25, 50, 100]

const numOrNull = (v) => (v === '' || v == null ? null : Number(v))
const textOrEmpty = (v) => (v == null ? '' : String(v))
const fmtDate = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
}
const sizeLabel = (row) => (
  row.size_inches != null ? `${fmtNum(row.size_inches)}"` : row.size_mm != null ? `${fmtNum(row.size_mm)} mm` : '—'
)

const blankForm = () => ({
  id: null,
  size_inches: '', size_mm: '', number_of_rolls: '',
  tare_weight_6mm: '', tare_weight_10mm: '', tare_weight_12mm: '',
  gross_weight: '', item_code: '', material_description: '',
  paper_core_weight: '', status: 'Active', remarks: '', product_id: null,
})

const rowToForm = (row) => ({
  id: row.id,
  size_inches: row.size_inches ?? '',
  size_mm: row.size_mm ?? '',
  number_of_rolls: row.number_of_rolls ?? '',
  tare_weight_6mm: row.tare_weight_6mm ?? '',
  tare_weight_10mm: row.tare_weight_10mm ?? '',
  tare_weight_12mm: row.tare_weight_12mm ?? '',
  gross_weight: row.gross_weight || '',
  item_code: row.item_code || '',
  material_description: row.material_description || '',
  paper_core_weight: row.paper_core_weight || '',
  status: row.status || 'Active',
  remarks: row.remarks || '',
  product_id: row.product_id ?? null,
})

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function StandardSizes() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sortBy, setSortBy] = useState('size_inches')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [products, setProducts] = useState([])

  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)

  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importError, setImportError] = useState('')

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const load = () => {
    setLoading(true)
    api.get('/standard-sizes', {
      params: { search, status: statusFilter, sort_by: sortBy, sort_dir: sortDir, page, page_size: pageSize },
    })
      .then((res) => { setItems(res.data.items || []); setTotal(res.data.total || 0) })
      .catch(() => { setItems([]); setTotal(0) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [statusFilter, sortBy, sortDir, page, pageSize])
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); load() }, 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [totalPages, page])
  useEffect(() => {
    api.get('/products', { params: { page_size: 500 } })
      .then((r) => setProducts(r.data.items || []))
      .catch(() => setProducts([]))
  }, [])

  const productOptions = useMemo(
    () => products.map((p) => ({
      id: p.id,
      label: `${p.item_code ? `${p.item_code} — ` : ''}${p.model || p.name || ''}`,
    })),
    [products],
  )

  const openNew = () => { setForm(blankForm()); setError(''); setDetail(null) }
  const openEdit = (row) => { setForm(rowToForm(row)); setError(''); setDetail(null) }

  const onPickProduct = (id, manual) => {
    const product = id ? products.find((p) => p.id === id) : null
    setForm((f) => ({
      ...f,
      product_id: product ? product.id : null,
      item_code: product ? (product.item_code || '') : (manual || ''),
      material_description: product && !f.material_description
        ? (product.model || product.name || '')
        : f.material_description,
    }))
  }

  const save = async () => {
    if (!form) return
    if (form.size_inches === '' && form.size_mm === '') {
      setError('Enter at least one of Size in Inches or Size in MM')
      return
    }
    const payload = {
      size_inches: numOrNull(form.size_inches),
      size_mm: numOrNull(form.size_mm),
      number_of_rolls: form.number_of_rolls === '' ? null : parseInt(form.number_of_rolls, 10),
      tare_weight_6mm: numOrNull(form.tare_weight_6mm),
      tare_weight_10mm: numOrNull(form.tare_weight_10mm),
      tare_weight_12mm: numOrNull(form.tare_weight_12mm),
      gross_weight: textOrEmpty(form.gross_weight),
      item_code: textOrEmpty(form.item_code),
      material_description: textOrEmpty(form.material_description),
      paper_core_weight: textOrEmpty(form.paper_core_weight),
      status: form.status || 'Active',
      remarks: textOrEmpty(form.remarks),
      product_id: form.product_id || null,
    }
    setSaving(true); setError('')
    try {
      if (form.id) {
        await api.patch(`/standard-sizes/${form.id}`, payload)
      } else {
        try {
          await api.post('/standard-sizes', payload)
        } catch (e) {
          if (e.response?.status === 409) {
            const message = e.response?.data?.detail || 'A duplicate standard size was detected.'
            if (!window.confirm(`${message}\n\nUpdate the existing record?`)) return
            await api.post('/standard-sizes', { ...payload, confirm_duplicate: true })
          } else {
            throw e
          }
        }
      }
      setForm(null)
      load()
    } catch (e) {
      const detail = e.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (row) => {
    const next = row.status === 'Active' ? 'Inactive' : 'Active'
    try {
      await api.patch(`/standard-sizes/${row.id}`, { status: next })
      load()
    } catch (e) {
      alert('Status update failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  const suggestMm = () => {
    const inches = Number(form.size_inches)
    if (!Number.isFinite(inches)) return
    setForm((f) => ({ ...f, size_mm: String(Math.round(inches * 25)) }))
  }

  const resetImport = () => {
    setImportFile(null); setPreview(null); setImportResult(null); setImportError('')
  }

  const pickImportFile = (file) => {
    setImportFile(file); setPreview(null); setImportResult(null); setImportError('')
  }

  const callPreview = async () => {
    if (!importFile) return
    setPreviewLoading(true); setImportError('')
    try {
      const fd = new FormData()
      fd.append('file', importFile)
      const res = await api.post('/standard-sizes/import/preview', fd)
      setPreview(res.data)
    } catch (e) {
      setImportError(e.response?.data?.detail || 'Could not preview this file')
    } finally {
      setPreviewLoading(false)
    }
  }

  const runImport = async () => {
    if (!importFile) return
    setImporting(true); setImportError('')
    try {
      const fd = new FormData()
      fd.append('file', importFile)
      const res = await api.post('/standard-sizes/import', fd)
      setImportResult(res.data)
      setPreview(res.data)
      load()
    } catch (e) {
      setImportError(e.response?.data?.detail || 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const downloadValidation = () => {
    const result = importResult || preview
    if (!result) return
    const rows = result.rows || []
    const csv = [
      ['Row', 'Size in Inches', 'Size in MM', 'Item Code', 'Description',
        'Gross Weight', 'Paper Core Weight', 'Status', 'Result', 'Messages'],
      ...rows.map((r) => [
        r.row, r.size_inches ?? '', r.size_mm ?? '', r.item_code || '',
        r.material_description || '', r.gross_weight || '', r.paper_core_weight || '',
        r.status_label || r.status || '', r.result || '',
        [...(r.errors || []), ...(r.warnings || [])].join('; '),
      ]),
    ].map((line) => line.map(csvCell).join(',')).join('\r\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'standard_size_import_validation.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  }

  const columns = [
    {
      key: 'size_inches', label: 'Size in Inches',
      render: (r) => <span className="font-medium whitespace-nowrap">{r.size_inches != null ? `${fmtNum(r.size_inches)}"` : '—'}</span>,
    },
    {
      key: 'size_mm', label: 'Size in MM',
      render: (r) => <span className="whitespace-nowrap">{r.size_mm != null ? `${fmtNum(r.size_mm)} mm` : '—'}</span>,
    },
    { key: 'rolls', label: 'No. of Rolls', render: (r) => r.number_of_rolls != null ? fmtNum(r.number_of_rolls) : '—' },
    { key: 't6', label: 'Tare 6 mm', render: (r) => r.tare_weight_6mm != null ? fmtNum(r.tare_weight_6mm) : '—' },
    { key: 't10', label: 'Tare 10 mm', render: (r) => r.tare_weight_10mm != null ? fmtNum(r.tare_weight_10mm) : '—' },
    { key: 't12', label: 'Tare 12 mm', render: (r) => r.tare_weight_12mm != null ? fmtNum(r.tare_weight_12mm) : '—' },
    {
      key: 'gross', label: 'Gross Weight / Range',
      render: (r) => <span className="whitespace-nowrap">{r.gross_weight || '—'}</span>,
    },
    {
      key: 'item_code', label: 'Item Code',
      render: (r) => <span className="font-mono text-xs whitespace-nowrap">{r.item_code || '—'}</span>,
    },
    {
      key: 'description', label: 'Material Description',
      render: (r) => <span className="block min-w-[200px] max-w-[320px] whitespace-normal">{r.material_description || '—'}</span>,
    },
    {
      key: 'core', label: 'Paper Core Weight',
      render: (r) => <span className="whitespace-nowrap">{r.paper_core_weight || '—'}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: (r) => (
        <Badge className={r.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'} dot={r.status === 'Active'}>
          {r.status}
        </Badge>
      ),
    },
    { key: 'created_by', label: 'Created By', render: (r) => <span className="whitespace-nowrap">{r.created_by || '—'}</span> },
    { key: 'created_at', label: 'Created Date', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.created_at)}</span> },
    { key: 'updated_by', label: 'Last Updated By', render: (r) => <span className="whitespace-nowrap">{r.updated_by || '—'}</span> },
    { key: 'updated_at', label: 'Last Updated Date', render: (r) => <span className="whitespace-nowrap text-xs">{fmtDate(r.updated_at)}</span> },
    {
      key: 'actions', label: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <button onClick={() => setDetail(r)} className="btn btn-ghost p-1.5" title="View"><Eye size={15} /></button>
          <button onClick={() => openEdit(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => toggleStatus(r)} className="btn btn-ghost p-1.5" title={r.status === 'Active' ? 'Deactivate' : 'Activate'}>
            <Power size={15} className={r.status === 'Active' ? 'text-green-600' : 'text-slate-400'} />
          </button>
        </div>
      ),
    },
  ]

  const resultRows = importResult?.rows || preview?.rows || []

  return (
    <div className="animate-fade-in-up">
      <PageHeader
        title="Standard Size Master"
        subtitle="Operations • Standard sheet sizes, core specifications and item links"
        actions={
          <>
            <button onClick={() => downloadFile('/standard-sizes/export', 'standard_sizes.xlsx')} className="btn btn-secondary">
              <Download size={15} /> Export
            </button>
            <button onClick={() => { resetImport(); setImportOpen(true) }} className="btn btn-secondary">
              <Upload size={15} /> Import
            </button>
            <button onClick={openNew} className="btn btn-primary">
              <Plus size={15} /> Add Standard Size
            </button>
          </>
        }
      />

      <Card
        subtitle={`${total} standard size${total === 1 ? '' : 's'} • blank tare weights are preserved as blank`}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search size, code, description…" className="input input-icon sm:w-64" />
            </div>
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }} className="input">
              <option value="">All statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            <div className="flex items-center gap-1">
              <ArrowUpDown size={14} className="text-slate-400" />
              <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPage(1) }} className="input">
                <option value="size_inches">Size (inches)</option>
                <option value="size_mm">Size (mm)</option>
                <option value="number_of_rolls">No. of rolls</option>
                <option value="item_code">Item code</option>
                <option value="material_description">Description</option>
                <option value="status">Status</option>
                <option value="created_at">Created date</option>
                <option value="updated_at">Updated date</option>
              </select>
              <button onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                className="btn btn-secondary px-2 py-1.5 text-xs" title="Toggle sort direction">
                {sortDir === 'asc' ? 'A → Z' : 'Z → A'}
              </button>
            </div>
          </div>
        }
      >
        {loading ? <Loading /> : items.length === 0
          ? <Empty text="No standard sizes yet — add one or import the Excel sheet" icon={Ruler} />
          : <Table columns={columns} data={items} keyField="id" stickyColumns={['size_inches']} dense />}
      </Card>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
        <div className="text-xs text-slate-500">
          {total === 0 ? 'No standard sizes'
            : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </div>
        <div className="flex items-center gap-2">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
            className="input py-1.5 text-sm w-28" aria-label="Rows per page">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
            className="btn btn-secondary p-2 disabled:opacity-40" aria-label="Previous page">
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-slate-600 tabular-nums">Page {page} of {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
            className="btn btn-secondary p-2 disabled:opacity-40" aria-label="Next page">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {detail && (
        <Modal open title={`Standard Size — ${sizeLabel(detail)}`} onClose={() => setDetail(null)} wide
          footer={<>
            <button onClick={() => setDetail(null)} className="btn btn-secondary">Close</button>
            <button onClick={() => openEdit(detail)} className="btn btn-primary"><Pencil size={14} /> Edit</button>
          </>}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <Info label="Size in Inches" value={detail.size_inches != null ? `${fmtNum(detail.size_inches)}"` : '—'} />
            <Info label="Size in MM" value={detail.size_mm != null ? `${fmtNum(detail.size_mm)} mm` : '—'} />
            <Info label="Number of Rolls" value={detail.number_of_rolls != null ? fmtNum(detail.number_of_rolls) : '—'} />
            <Info label="Tare Weight 6 mm" value={detail.tare_weight_6mm != null ? fmtNum(detail.tare_weight_6mm) : '—'} />
            <Info label="Tare Weight 10 mm" value={detail.tare_weight_10mm != null ? fmtNum(detail.tare_weight_10mm) : '—'} />
            <Info label="Tare Weight 12 mm" value={detail.tare_weight_12mm != null ? fmtNum(detail.tare_weight_12mm) : '—'} />
            <Info label="Gross Weight / Range" value={detail.gross_weight || '—'} />
            <Info label="Item Code" value={detail.item_code || '—'} />
            <Info label="Paper Core Weight" value={detail.paper_core_weight || '—'} />
            <Info label="Status" value={detail.status} />
            <Info label="Created By" value={detail.created_by || '—'} />
            <Info label="Created Date" value={fmtDate(detail.created_at)} />
            <Info label="Last Updated By" value={detail.updated_by || '—'} />
            <Info label="Last Updated Date" value={fmtDate(detail.updated_at)} />
          </div>
          <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Material Description</div>
            <div>{detail.material_description || '—'}</div>
          </div>
          {detail.remarks && (
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Remarks</div>
              <div>{detail.remarks}</div>
            </div>
          )}
          <div className="mt-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Linked Inventory Item</div>
            {detail.product ? (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span><span className="text-slate-500">Code:</span> <span className="font-mono">{detail.product.item_code || '—'}</span></span>
                <span><span className="text-slate-500">Description:</span> {detail.product.model || detail.product.name || '—'}</span>
                <span><span className="text-slate-500">Unit:</span> {detail.product.uom || '—'}</span>
              </div>
            ) : (
              <span className="text-slate-500">Not linked to an inventory item (optional).</span>
            )}
          </div>
        </Modal>
      )}

      {form && (
        <Modal open title={form.id ? 'Edit Standard Size' : 'Add Standard Size'} onClose={() => setForm(null)} wide
          footer={<>
            <button onClick={() => setForm(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={saving} className="btn btn-primary">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>}>
          {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="block text-slate-500 text-xs mb-1">Size in Inches</label>
              <input type="number" min="0" step="0.01" value={form.size_inches}
                onChange={(e) => setForm({ ...form, size_inches: e.target.value })} className="input" placeholder='e.g. 2' />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Size in MM</label>
              <div className="flex gap-1">
                <input type="number" min="0" step="0.01" value={form.size_mm}
                  onChange={(e) => setForm({ ...form, size_mm: e.target.value })} className="input" placeholder="e.g. 50" />
                <button type="button" onClick={suggestMm} className="btn btn-secondary px-2 text-xs whitespace-nowrap"
                  title="Suggest millimetres from inches (nominal 1 inch = 25 mm, matching existing records)">
                  Suggest
                </button>
              </div>
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Number of Rolls</label>
              <input type="number" min="0" step="1" value={form.number_of_rolls}
                onChange={(e) => setForm({ ...form, number_of_rolls: e.target.value })} className="input" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Tare Weight 6 mm</label>
              <input type="number" min="0" step="0.01" value={form.tare_weight_6mm}
                onChange={(e) => setForm({ ...form, tare_weight_6mm: e.target.value })} className="input" placeholder="Leave blank if not specified" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Tare Weight 10 mm</label>
              <input type="number" min="0" step="0.01" value={form.tare_weight_10mm}
                onChange={(e) => setForm({ ...form, tare_weight_10mm: e.target.value })} className="input" placeholder="Leave blank if not specified" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Tare Weight 12 mm</label>
              <input type="number" min="0" step="0.01" value={form.tare_weight_12mm}
                onChange={(e) => setForm({ ...form, tare_weight_12mm: e.target.value })} className="input" placeholder="Leave blank if not specified" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Gross Weight / Weight Range</label>
              <input value={form.gross_weight} onChange={(e) => setForm({ ...form, gross_weight: e.target.value })}
                className="input" placeholder="e.g. 26-27" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Paper Core Weight</label>
              <input value={form.paper_core_weight} onChange={(e) => setForm({ ...form, paper_core_weight: e.target.value })}
                className="input" placeholder="e.g. 650 G" />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-slate-500 text-xs mb-1">Linked Item Code <span className="text-slate-400">(optional)</span></label>
              <SearchSelect
                options={productOptions}
                value={form.product_id}
                initialLabel={form.product_id ? '' : form.item_code}
                placeholder="Search existing inventory item or type a code"
                onChange={onPickProduct}
              />
            </div>
            <div>
              <label className="block text-slate-500 text-xs mb-1">Material Description</label>
              <input value={form.material_description} onChange={(e) => setForm({ ...form, material_description: e.target.value })}
                className="input" placeholder="Auto-filled when an item is linked" />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-slate-500 text-xs mb-1">Remarks</label>
              <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                className="input" placeholder="Optional notes" />
            </div>
          </div>
          {form.product_id && (
            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Linked item: <span className="font-mono">{form.item_code || '—'}</span>
              {products.find((p) => p.id === form.product_id)?.model
                ? ` — ${products.find((p) => p.id === form.product_id).model}` : ''}
            </div>
          )}
          <div className="mt-2 text-[11px] text-slate-400">
            The linked item only references the existing inventory master; no duplicate inventory item is created.
            Tare weights and gross weight may be left blank exactly as in the source sheet.
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal open title="Import Standard Sizes" onClose={() => setImportOpen(false)} xwide
          footer={<>
            <button onClick={() => setImportOpen(false)} className="btn btn-secondary">Close</button>
            <button onClick={callPreview} disabled={!importFile || previewLoading} className="btn btn-secondary">
              {previewLoading ? 'Reading…' : 'Preview'}
            </button>
            <button onClick={runImport} disabled={!importFile || !preview || importing || preview.summary?.valid === 0}
              className="btn btn-primary">
              {importing ? 'Importing…' : 'Import Valid Rows'}
            </button>
          </>}>
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm">
            <label className="block text-slate-600 text-xs font-medium mb-2">Excel file (.xlsx / .xls / .csv)</label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => pickImportFile(e.target.files?.[0] || null)}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-white file:text-xs" />
            {importFile && <div className="mt-2 text-xs text-slate-500">Selected: {importFile.name}</div>}
          </div>

          {importError && <div className="mt-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{importError}</div>}

          {preview && (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <Badge className="bg-green-100 text-green-700">Valid: {preview.summary?.valid || 0}</Badge>
                <Badge className="bg-amber-100 text-amber-700">Duplicates: {preview.summary?.duplicates || 0}</Badge>
                <Badge className="bg-red-100 text-red-600">Invalid: {preview.summary?.invalid || 0}</Badge>
                <Badge className="bg-slate-100 text-slate-600">Rows: {preview.summary?.total || 0}</Badge>
                {importResult && (
                  <>
                    <Badge className="bg-green-100 text-green-700">Imported: {importResult.summary?.imported || 0}</Badge>
                    <Badge className="bg-slate-100 text-slate-600">Skipped: {importResult.summary?.skipped || 0}</Badge>
                    <Badge className="bg-red-100 text-red-600">Failed: {importResult.summary?.failed || 0}</Badge>
                  </>
                )}
                <button onClick={downloadValidation} className="btn btn-secondary ml-auto px-2 py-1 text-[11px]">
                  <Download size={12} /> Validation results
                </button>
              </div>

              <div className="mt-4">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500 uppercase mb-1">
                  <FileSpreadsheet size={14} /> Column mapping
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {Object.entries(preview.mapping || {}).map(([field, column]) => (
                    <span key={field} className="rounded-md bg-slate-100 px-2 py-1 text-slate-600">
                      {column} → <span className="font-medium text-slate-800">{field.replace(/_/g, ' ')}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5">Row</th>
                      <th className="px-2 py-1.5">Size</th>
                      <th className="px-2 py-1.5">Item Code</th>
                      <th className="px-2 py-1.5">Description</th>
                      <th className="px-2 py-1.5">Gross Weight</th>
                      <th className="px-2 py-1.5">Core Weight</th>
                      <th className="px-2 py-1.5">Status</th>
                      <th className="px-2 py-1.5">Messages</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {resultRows.map((r) => {
                      const label = r.result || r.status_label || (r.errors?.length ? 'Invalid' : 'Valid')
                      const bad = label === 'Invalid' || label === 'Failed'
                      const dup = label === 'Duplicate' || String(label).startsWith('Skipped')
                      return (
                        <tr key={`${r.row}-${r.item_code}`} className={bad ? 'bg-red-50/50' : dup ? 'bg-amber-50/50' : ''}>
                          <td className="px-2 py-1.5 text-slate-400">{r.row}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">{sizeLabel(r)}</td>
                          <td className="px-2 py-1.5 font-mono">{r.item_code || '—'}</td>
                          <td className="px-2 py-1.5 max-w-[220px] whitespace-normal">{r.material_description || '—'}</td>
                          <td className="px-2 py-1.5">{r.gross_weight || '—'}</td>
                          <td className="px-2 py-1.5">{r.paper_core_weight || '—'}</td>
                          <td className="px-2 py-1.5">
                            <Badge className={bad ? 'bg-red-100 text-red-600'
                              : dup ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}>
                              {label}
                            </Badge>
                          </td>
                          <td className="px-2 py-1.5 text-[11px] text-slate-500">
                            {[...(r.errors || []), ...(r.warnings || [])].join('; ') || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1">
                <AlertTriangle size={12} /> Duplicates and invalid rows are never imported or overwritten.
                <CheckCircle2 size={12} className="ml-2 text-green-500" /> Blank tare weights stay blank.
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

function Info({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-medium text-slate-800 mt-0.5 break-words">{value}</div>
    </div>
  )
}
