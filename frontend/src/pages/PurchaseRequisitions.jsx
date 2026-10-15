import { useEffect, useMemo, useState } from 'react'
import {
  RefreshCw, Plus, Trash2, FileText, ClipboardList, CheckCircle2, XCircle,
  Send, Ban, Eye, Paperclip, Printer, History, AlertTriangle,
} from 'lucide-react'
import api, { downloadFile } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard, StatusBadge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const STATUS_CLS = {
  Draft: 'bg-slate-100 text-slate-600',
  'Pending Approval': 'bg-amber-100 text-amber-700',
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-600',
  'Sent to Purchase': 'bg-cyan-100 text-cyan-700',
  'Partially Fulfilled': 'bg-blue-100 text-blue-700',
  Completed: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}

const today = () => new Date().toISOString().slice(0, 10)

const UOMS = [
  'Nos', 'Kg', 'Box', 'Ton', 'Roll', 'Meter', 'Litre', 'ML', 'Gram',
  'Packet', 'Set', 'Piece', 'Bag', 'Drum', 'Bundle', 'Pair', 'Dozen', 'Sq.Mtr',
]

function emptyLine() {
  return {
    _key: Math.random().toString(36).slice(2),
    id: null, entry_mode: 'MANUAL', material_id: null, material_code: '',
    description: '', specification: '', quantity: '', uom: '', remarks: '',
    available_stock: null, reserved_stock: null, incoming_qty: null, suggested_qty: null,
    attachment_name: '', has_attachment: false,
  }
}

function lineFromApi(l) {
  return {
    _key: 'l' + (l.id ?? Math.random().toString(36).slice(2)),
    id: l.id, entry_mode: l.entry_mode, material_id: l.material_id,
    material_code: l.material_code || '', description: l.description || '',
    specification: l.specification || '', quantity: l.quantity, uom: l.uom || '',
    remarks: l.remarks || '', available_stock: l.available_stock,
    reserved_stock: l.reserved_stock, incoming_qty: l.incoming_qty,
    suggested_qty: l.suggested_qty, attachment_name: l.attachment_name,
    has_attachment: l.has_attachment,
  }
}

export default function PRN() {
  const { user } = useAuth()
  const isManager = user?.role === 'admin' || user?.role === 'manager'
  const isAdmin = user?.role === 'admin'

  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState({ priorities: [], requirement_types: [], statuses: [] })
  const [departments, setDepartments] = useState([])
  const [materials, setMaterials] = useState([])

  const [filters, setFilters] = useState({ search: '', department: '', status: '', priority: '' })

  const [editor, setEditor] = useState(null) // { mode, prn } or null
  const [detail, setDetail] = useState(null)

  const load = () => {
    setLoading(true)
    api.get('/prn', { params: { ...filters, page_size: 500 } })
      .then((res) => { setRows(res.data.items || []); setTotal(res.data.total) })
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    api.get('/prn/constants').then((r) => setMeta(r.data)).catch(() => {})
    api.get('/prn/departments').then((r) => setDepartments(r.data || [])).catch(() => {})
    api.get('/prn/materials', { params: { limit: 200 } }).then((r) => setMaterials(r.data || [])).catch(() => {})
  }, [])

  useEffect(() => { load() }, [filters.department, filters.status, filters.priority])

  const counts = useMemo(() => ({
    pending: rows.filter((r) => r.status === 'Pending Approval').length,
    approved: rows.filter((r) => r.status === 'Approved' || r.status === 'Sent to Purchase').length,
    open: rows.filter((r) => !['Completed', 'Cancelled', 'Rejected'].includes(r.status)).length,
  }), [rows])

  const actions = (r) => {
    const requester = r.requested_by_id === user?.id
    const canEdit = ['Draft', 'Rejected'].includes(r.status) && (requester || isAdmin)
    const canSubmit = canEdit
    const canApprove = r.status === 'Pending Approval' && isManager && (!requester || isAdmin)
    const canCancel = !['Completed', 'Cancelled'].includes(r.status) && (requester || isManager)
    const canSend = r.status === 'Approved' && isManager
    return { canEdit, canSubmit, canApprove, canCancel, canSend }
  }

  const openNew = () => setEditor({ mode: 'new', prn: {
    company_name: 'Kalika Enterprises', department: '', department_head: '',
    prn_date: today(), required_by_date: '', priority: 'Normal',
    requirement_type: 'Production', purpose: '', production_reference: '',
    checked_by_name: '', purchase_remarks: '',
    lines: [emptyLine()],
  } })

  const openEdit = async (r) => {
    const { data } = await api.get(`/prn/${r.id}`)
    setEditor({ mode: 'edit', prn: { ...data, lines: (data.lines || []).map(lineFromApi) } })
  }

  const openDetail = async (r) => {
    const { data } = await api.get(`/prn/${r.id}`)
    setDetail(data)
  }

  const act = (id, path, body, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    api.post(`/prn/${id}/${path}`, body)
      .then(() => { setDetail(null); load() })
      .catch((err) => alert('Action failed: ' + (err.response?.data?.detail || err.message)))
  }

  const reject = (id) => {
    const reason = window.prompt('Rejection reason (required):')
    if (!reason || !reason.trim()) return
    act(id, 'reject', { reason: reason.trim() })
  }

  const fulfill = (id) => {
    const status = window.prompt('Fulfilment status: Pending / Partially Fulfilled / Completed', 'Completed')
    if (!status) return
    act(id, 'fulfillment', { fulfillment_status: status })
  }

  const cols = [
    { key: 'prn_number', label: 'PRN No.', render: (r) => <span className="font-mono text-xs font-semibold">{r.prn_number}</span> },
    { key: 'prn_date', label: 'PRN Date' },
    { key: 'department', label: 'Department', render: (r) => r.department || '—' },
    { key: 'requested_by_name', label: 'Requested By', render: (r) => r.requested_by_name || '—' },
    { key: 'required_by_date', label: 'Required By', render: (r) => r.required_by_date || '—' },
    { key: 'priority', label: 'Priority', render: (r) => (
      <Badge className={r.priority === 'Critical' ? 'bg-red-100 text-red-700' : r.priority === 'Urgent' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}>{r.priority}</Badge>
    )},
    { key: 'item_count', label: 'Items', render: (r) => r.item_count },
    { key: 'status', label: 'Approval', render: (r) => <Badge className={STATUS_CLS[r.status] || 'bg-gray-100 text-gray-600'}>{r.status}</Badge> },
    { key: 'fulfillment_status', label: 'Fulfilment', render: (r) => <StatusBadge status={r.fulfillment_status} /> },
    { key: 'created_at', label: 'Created', render: (r) => (r.created_at || '').slice(0, 10) },
    { key: 'actions', label: 'Actions', render: (r) => {
      const a = actions(r)
      return (
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => openDetail(r)} title="View" className="btn-icon"><Eye size={15} /></button>
          {a.canEdit && <button onClick={() => openEdit(r)} title="Edit" className="btn-icon"><FileText size={15} /></button>}
          {a.canSubmit && <button onClick={() => act(r.id, 'submit', null, `Submit ${r.prn_number} for approval?`)} title="Submit" className="btn-icon text-amber-600"><Send size={15} /></button>}
          {a.canApprove && <button onClick={() => act(r.id, 'approve', null, `Approve ${r.prn_number}?`)} title="Approve" className="btn-icon text-green-600"><CheckCircle2 size={15} /></button>}
          {a.canApprove && <button onClick={() => reject(r.id)} title="Reject" className="btn-icon text-red-600"><XCircle size={15} /></button>}
          {a.canSend && <button onClick={() => act(r.id, 'send-to-purchase', null, `Send ${r.prn_number} to purchase?`)} title="Send to Purchase" className="btn-icon text-cyan-600"><Send size={15} /></button>}
          {r.status === 'Sent to Purchase' && isManager && <button onClick={() => fulfill(r.id)} title="Update fulfilment" className="btn-icon"><ClipboardList size={15} /></button>}
          {a.canCancel && <button onClick={() => act(r.id, 'cancel', null, `Cancel ${r.prn_number}?`)} title="Cancel" className="btn-icon text-red-600"><Ban size={15} /></button>}
        </div>
      )
    }},
  ]

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Purchase Requisition Note" subtitle="Material purchase requirements & approval workflow"
        actions={<>
          <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
          <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> New PRN</button>
        </>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total PRNs" value={total} icon={ClipboardList} iconClass="bg-slate-100 text-slate-600" />
        <StatCard label="Pending Approval" value={counts.pending} icon={AlertTriangle} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
        <StatCard label="Approved / Sent" value={counts.approved} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Open" value={counts.open} icon={FileText} iconClass="bg-sky-50 text-sky-600" />
      </div>

      <Card>
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <input value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Search PRN no. / material description…" className="input text-sm py-1.5 px-3 w-72" />
          <select value={filters.department} onChange={(e) => setFilters((f) => ({ ...f, department: e.target.value }))} className="input text-sm py-1.5 px-2 w-44">
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="input text-sm py-1.5 px-2 w-44">
            <option value="">All Statuses</option>
            {meta.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))} className="input text-sm py-1.5 px-2 w-32">
            <option value="">All Priority</option>
            {meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={load} className="btn btn-secondary"><RefreshCw size={14} /> Search</button>
        </div>
        <div className="text-sm text-slate-500 mb-2">{total} PRN(s)</div>
        {loading ? <Loading /> : rows.length === 0 ? <Empty text="No PRNs yet" /> : <Table columns={cols} data={rows} keyField="id" dense />}
      </Card>

      {editor && (
        <EditorModal editor={editor} setEditor={setEditor} meta={meta} departments={departments}
          materials={materials} currentUser={user} onSaved={() => { setEditor(null); load() }} />
      )}

      {detail && (
        <DetailModal detail={detail} setDetail={setDetail} isManager={isManager} isAdmin={isAdmin}
          requesterId={user?.id} onAct={act} onReject={reject} onFulfill={fulfill} />
      )}
    </div>
  )
}

function EditorModal({ editor, setEditor, meta, departments, materials, currentUser, onSaved }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const prn = editor.prn
  const set = (patch) => setEditor((e) => ({ ...e, prn: { ...e.prn, ...patch } }))

  const setLine = (key, patch) => set({ lines: prn.lines.map((l) => (l._key === key ? { ...l, ...patch } : l)) })
  const addLine = () => set({ lines: [...prn.lines, emptyLine()] })
  const removeLine = (key) => set({ lines: prn.lines.filter((l) => l._key !== key) })

  const stockFor = async (key, id, qty) => {
    try {
      const { data } = await api.get('/prn/stock-lookup', { params: { material_id: id, required_qty: qty || undefined } })
      setLine(key, { available_stock: data.available_stock, reserved_stock: data.reserved_stock,
                     incoming_qty: data.incoming_qty, suggested_qty: data.suggested_qty })
    } catch { /* stock unknown — leave blank, never assume zero */ }
  }

  const findLocal = (value) => {
    const v = value.trim().toLowerCase()
    return materials.find((x) => (x.item_code || '').toLowerCase() === v
      || (x.model || '').toLowerCase() === v || x.label.toLowerCase() === v)
  }

  const applyMaterial = (key, m) => {
    setLine(key, { material_id: m.id, entry_mode: 'EXISTING', material_code: m.item_code || '',
                   description: m.model, uom: m.uom || '' })
    stockFor(key, m.id, prn.lines.find((l) => l._key === key)?.quantity)
  }

  // Item Code cell: matches a master material by item_code or model; anything else
  // is a manual (New Material) line. Matched lines stay EXISTING, unmatched MANUAL.
  const onCode = (key, value) => {
    const m = findLocal(value)
    if (m) applyMaterial(key, m)
    else setLine(key, { material_id: null, entry_mode: 'MANUAL', material_code: value })
  }

  // On blur, fall back to a server lookup so a code outside the first page of the
  // master still resolves to its material (and therefore its stock).
  const resolveCode = async (key, value) => {
    if (findLocal(value)) return
    const v = value.trim().toLowerCase()
    if (v.length < 2) return
    try {
      const { data } = await api.get('/prn/materials', { params: { search: value, limit: 20 } })
      const m = (data || []).find((x) => (x.item_code || '').toLowerCase() === v)
      if (m) applyMaterial(key, m)
    } catch { /* left as manual */ }
  }

  const uploadFor = async (lineId, file) => {
    const fd = new FormData()
    fd.append('file', file)
    try {
      await api.post(`/prn/${prn.id}/lines/${lineId}/attachment`, fd)
      const { data } = await api.get(`/prn/${prn.id}`)
      set({ lines: (data.lines || []).map(lineFromApi) })
    } catch (err) { alert('Upload failed: ' + (err.response?.data?.detail || err.message)) }
  }

  const payload = () => ({
    prn_date: prn.prn_date || null,
    department: prn.department || '',
    department_head: prn.department_head || '',
    company_name: prn.company_name || '',
    required_by_date: prn.required_by_date || null,
    priority: prn.priority,
    requirement_type: prn.requirement_type,
    purpose: prn.purpose || '',
    production_reference: prn.production_reference || '',
    checked_by_name: prn.checked_by_name || '',
    purchase_remarks: prn.purchase_remarks || '',
    lines: prn.lines.map((l) => ({
      id: l.id || undefined,
      entry_mode: l.material_id ? 'EXISTING' : 'MANUAL',
      material_id: l.material_id || undefined,
      material_code: l.material_code || '',
      description: l.description || '',
      specification: l.specification || '',
      quantity: Number(l.quantity) || 0,
      uom: l.uom || '',
      remarks: l.remarks || '',
    })),
  })

  const save = async () => {
    setError('')
    if (prn.lines.length === 0) { setError('Add at least one material line.'); return }
    const bad = prn.lines.find((l) => !String(l.description || '').trim() || !(Number(l.quantity) > 0))
    if (bad) { setError('Each line needs a material description and a required quantity greater than zero.'); return }
    setSaving(true)
    try {
      if (editor.mode === 'new') await api.post('/prn', payload())
      else await api.patch(`/prn/${prn.id}`, payload())
      onSaved()
    } catch (err) {
      const d = err.response?.data?.detail
      setError(Array.isArray(d) ? d.map((x) => x.msg).join('; ') : (d || err.message))
    } finally { setSaving(false) }
  }

  const title = editor.mode === 'new' ? 'New PRN' : `Edit ${prn.prn_number}`

  return (
    <Modal open wide title={title} subtitle="Purchase Requisition Note" onClose={() => setEditor(null)}
      footer={<>
        {error && <span className="text-red-600 text-sm mr-auto">{error}</span>}
        <button onClick={() => setEditor(null)} className="btn btn-secondary">Cancel</button>
        <button onClick={save} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save Draft'}</button>
      </>}>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <label className="text-xs">Company Name
          <input value={prn.company_name || ''} onChange={(e) => set({ company_name: e.target.value })} className="input w-full mt-1" />
        </label>
        <label className="text-xs">PRN No.
          <input value={prn.prn_number || '(auto on save)'} readOnly className="input w-full mt-1 bg-slate-50 font-mono" />
        </label>
        <label className="text-xs">PRN Date
          <input type="date" value={prn.prn_date || ''} onChange={(e) => set({ prn_date: e.target.value })} className="input w-full mt-1" />
        </label>
        <label className="text-xs">Department
          <input list="prn-depts" value={prn.department} onChange={(e) => set({ department: e.target.value })} className="input w-full mt-1" />
          <datalist id="prn-depts">{departments.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        <label className="text-xs">Department Head
          <input value={prn.department_head || ''} onChange={(e) => set({ department_head: e.target.value })} className="input w-full mt-1" />
        </label>
        <label className="text-xs">Requested By
          <input value={prn.requested_by_name || currentUser?.full_name || currentUser?.username || '(you)'} readOnly className="input w-full mt-1 bg-slate-50" />
        </label>
        <label className="text-xs">Required Date
          <input type="date" value={prn.required_by_date || ''} onChange={(e) => set({ required_by_date: e.target.value })} className="input w-full mt-1" />
        </label>
        <label className="text-xs">Priority
          <select value={prn.priority} onChange={(e) => set({ priority: e.target.value })} className="input w-full mt-1">
            {meta.priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-xs">Requirement Type
          <select value={prn.requirement_type} onChange={(e) => set({ requirement_type: e.target.value })} className="input w-full mt-1">
            {meta.requirement_types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <label className="text-xs block mb-4">Purpose of Requisition
        <textarea value={prn.purpose || ''} onChange={(e) => set({ purpose: e.target.value })} rows={2} className="input w-full mt-1" />
      </label>

      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-slate-700 text-sm">Material Requirements</div>
        <button onClick={addLine} className="btn btn-secondary btn-sm"><Plus size={14} /> Add Row</button>
      </div>
      <div className="table-wrap">
        <table className="data-table table-dense">
          <thead><tr>
            <th className="w-10">Sr. No.</th><th className="min-w-40">Item Code</th><th className="min-w-56">Material Description</th>
            <th>Specification</th><th>UOM</th><th>Required Qty.</th><th>Stock Qty.</th><th>Purpose / Remarks</th><th></th>
          </tr></thead>
          <tbody>
            {prn.lines.map((l, i) => (
              <tr key={l._key}>
                <td className="text-xs text-slate-500">{i + 1}</td>
                <td>
                  <input list="prn-materials" value={l.material_code} onChange={(e) => onCode(l._key, e.target.value)}
                    onBlur={(e) => resolveCode(l._key, e.target.value)}
                    placeholder="Code or new item" className="input text-xs py-1 px-2 w-full font-mono" />
                </td>
                <td>
                  <input value={l.description} onChange={(e) => setLine(l._key, { description: e.target.value })}
                    placeholder={l.material_id ? '' : 'Describe material (New Material – Master Review Required)'} className="input text-xs py-1 px-2 w-full" />
                </td>
                <td><input value={l.specification} onChange={(e) => setLine(l._key, { specification: e.target.value })} className="input text-xs py-1 px-2 w-32" /></td>
                <td><input list="prn-uoms" value={l.uom} onChange={(e) => setLine(l._key, { uom: e.target.value })} className="input text-xs py-1 px-2 w-20" /></td>
                <td><input type="number" min="0" step="any" value={l.quantity} onChange={(e) => setLine(l._key, { quantity: e.target.value })}
                  onBlur={(e) => l.material_id && stockFor(l._key, l.material_id, e.target.value)} className="input text-xs py-1 px-2 w-20" /></td>
                <td className="text-xs" title="Available stock (Main Store)">{l.available_stock == null ? '—' : fmtNum(l.available_stock)}</td>
                <td><input value={l.remarks} onChange={(e) => setLine(l._key, { remarks: e.target.value })} className="input text-xs py-1 px-2 w-40" /></td>
                <td>
                  <div className="flex items-center gap-1">
                    {l.id ? (
                      <label title="Attach" className="btn-icon cursor-pointer">
                        <Paperclip size={14} />
                        <input type="file" className="hidden" onChange={(e) => e.target.files[0] && uploadFor(l.id, e.target.files[0])} />
                      </label>
                    ) : null}
                    <button onClick={() => removeLine(l._key)} className="btn-icon text-red-600" title="Remove"><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="prn-materials">
        {materials.map((m) => <option key={m.id} value={m.item_code || m.model}>{m.model}</option>)}
      </datalist>
      <datalist id="prn-uoms">
        {UOMS.map((u) => <option key={u} value={u} />)}
      </datalist>
      <p className="text-xs text-slate-400 mt-2">
        Item Code matched to a material fills its description, UOM and stock. Unmatched codes are
        <b> New Material – Master Review Required</b> (stock unknown, not zero).
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 border-t pt-4">
        <label className="text-xs">Checked By (Store)
          <input value={prn.checked_by_name || ''} onChange={(e) => set({ checked_by_name: e.target.value })} className="input w-full mt-1" />
        </label>
        <label className="text-xs">Purchase Department Remarks
          <textarea value={prn.purchase_remarks || ''} onChange={(e) => set({ purchase_remarks: e.target.value })} rows={2} className="input w-full mt-1" />
        </label>
      </div>
    </Modal>
  )
}

function DetailModal({ detail, setDetail, isManager, isAdmin, requesterId, onAct, onReject, onFulfill }) {
  const requester = detail.requested_by_id === requesterId
  const status = detail.status
  const canSubmit = ['Draft', 'Rejected'].includes(status) && (requester || isAdmin)
  const canApprove = status === 'Pending Approval' && isManager && (!requester || isAdmin)
  const canSend = status === 'Approved' && isManager
  const canCancel = !['Completed', 'Cancelled'].includes(status) && (requester || isManager)

  const print = () => {
    const w = window.open('', '_blank')
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    const rowsHtml = detail.lines.map((l, i) => `<tr>
      <td>${i + 1}</td><td>${esc(l.material_code)}</td><td>${esc(l.description)}</td>
      <td>${esc(l.specification)}</td><td>${esc(l.uom)}</td><td>${fmtNum(l.quantity)}</td>
      <td>${l.available_stock == null ? '—' : fmtNum(l.available_stock)}</td>
      <td>${esc(l.remarks)}</td></tr>`).join('')
    w.document.write(`<html><head><title>${esc(detail.prn_number)}</title>
      <style>body{font-family:Arial;padding:24px;color:#111}h1{font-size:18px;margin:0}
      .co{font-size:20px;font-weight:bold}h2{font-size:14px;font-weight:normal;margin:2px 0 12px}
      table{border-collapse:collapse;width:100%;font-size:12px;margin-top:12px}
      th,td{border:1px solid #999;padding:4px 6px;text-align:left}th{background:#eee}
      .meta{font-size:12px;margin-top:8px}.meta span{margin-right:18px}
      .sign{width:100%;margin-top:48px;font-size:12px}
      .sign td{border:none;padding-top:32px;vertical-align:bottom}
      .line{border-top:1px solid #333;padding-top:3px;min-width:150px;display:inline-block}</style></head><body>
      <div class="co">${esc(detail.company_name) || 'Kalika Enterprises'}</div>
      <h2>Purchase Requisition Note</h2>
      <div class="meta"><span><b>PRN No.:</b> ${esc(detail.prn_number)}</span>
      <span><b>PRN Date:</b> ${esc(detail.prn_date)}</span>
      <span><b>Department:</b> ${esc(detail.department)}</span></div>
      <div class="meta"><span><b>Requested By:</b> ${esc(detail.requested_by_name)}</span>
      <span><b>Required Date:</b> ${esc(detail.required_by_date)}</span>
      <span><b>Department Head:</b> ${esc(detail.department_head)}</span></div>
      <table><thead><tr><th>Sr. No.</th><th>Item Code</th><th>Material Description</th><th>Specification</th>
      <th>UOM</th><th>Required Qty.</th><th>Stock Qty.</th><th>Purpose / Remarks</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>
      <div class="meta"><b>Purpose of Requisition:</b> ${esc(detail.purpose)}</div>
      <table class="sign"><tr>
        <td><span class="line">Requested By</span><br>${esc(detail.requested_by_name)}</td>
        <td><span class="line">Checked By (Store)</span><br>${esc(detail.checked_by_name)}</td>
        <td><span class="line">Approved By</span><br>${esc(detail.approved_by_name)}</td>
      </tr></table>
      <div class="meta"><b>Purchase Department Remarks:</b> ${esc(detail.purchase_remarks)}</div>
      <p style="font-size:11px;color:#666;margin-top:24px">This is a purchase requirement document. No purchase order or stock movement is created automatically.</p>
      </body></html>`)
    w.document.close()
    w.print()
  }

  return (
    <Modal open xwide title={detail.prn_number} subtitle={`${detail.department || ''} · ${detail.status}`}
      onClose={() => setDetail(null)}
      footer={<>
        <button onClick={print} className="btn btn-secondary mr-auto"><Printer size={14} /> Print</button>
        {canSubmit && <button onClick={() => onAct(detail.id, 'submit', null, `Submit ${detail.prn_number}?`)} className="btn btn-secondary"><Send size={14} /> Submit</button>}
        {canApprove && <button onClick={() => onReject(detail.id)} className="btn btn-secondary text-red-600"><XCircle size={14} /> Reject</button>}
        {canApprove && <button onClick={() => onAct(detail.id, 'approve', null, 'Approve this PRN?')} className="btn btn-primary"><CheckCircle2 size={14} /> Approve</button>}
        {canSend && <button onClick={() => onAct(detail.id, 'send-to-purchase', null, 'Send to purchase?')} className="btn btn-primary"><Send size={14} /> Send to Purchase</button>}
        {status === 'Sent to Purchase' && isManager && <button onClick={() => onFulfill(detail.id)} className="btn btn-secondary"><ClipboardList size={14} /> Update Fulfilment</button>}
        {canCancel && <button onClick={() => onAct(detail.id, 'cancel', null, 'Cancel this PRN?')} className="btn btn-secondary text-red-600"><Ban size={14} /> Cancel</button>}
      </>}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div><div className="text-xs text-slate-400">Company</div>{detail.company_name || '—'}</div>
        <div><div className="text-xs text-slate-400">PRN Date</div>{detail.prn_date || '—'}</div>
        <div><div className="text-xs text-slate-400">Department</div>{detail.department || '—'}</div>
        <div><div className="text-xs text-slate-400">Department Head</div>{detail.department_head || '—'}</div>
        <div><div className="text-xs text-slate-400">Requested By</div>{detail.requested_by_name || '—'}</div>
        <div><div className="text-xs text-slate-400">Required Date</div>{detail.required_by_date || '—'}</div>
        <div><div className="text-xs text-slate-400">Priority</div>{detail.priority}</div>
        <div><div className="text-xs text-slate-400">Requirement Type</div>{detail.requirement_type}</div>
        <div><div className="text-xs text-slate-400">Fulfilment</div><StatusBadge status={detail.fulfillment_status} /></div>
        <div><div className="text-xs text-slate-400">Checked By (Store)</div>{detail.checked_by_name || '—'}</div>
        <div><div className="text-xs text-slate-400">Approved By</div>{detail.approved_by_name || '—'}</div>
        <div><div className="text-xs text-slate-400">Purchase Ref</div>{detail.purchase_reference || '—'}</div>
      </div>
      {detail.purpose && <div className="text-sm mb-4"><span className="text-xs text-slate-400 block">Purpose of Requisition</span>{detail.purpose}</div>}
      {detail.purchase_remarks && <div className="text-sm mb-4"><span className="text-xs text-slate-400 block">Purchase Department Remarks</span>{detail.purchase_remarks}</div>}
      {detail.rejection_reason && <div className="text-sm mb-4 text-red-600"><span className="text-xs text-slate-400 block">Rejection Reason</span>{detail.rejection_reason}</div>}

      <div className="table-wrap mb-4">
        <table className="data-table table-dense">
          <thead><tr>
            <th>Sr. No.</th><th>Item Code</th><th>Material Description</th><th>Specification</th><th>UOM</th>
            <th>Required Qty.</th><th>Stock Qty.</th><th>Purpose / Remarks</th><th>File</th>
          </tr></thead>
          <tbody>
            {detail.lines.map((l, i) => (
              <tr key={l.id}>
                <td className="text-xs text-slate-500">{i + 1}</td>
                <td className="font-mono text-xs">{l.material_code || '—'}</td>
                <td className="font-medium">
                  {l.description}
                  {l.is_new_material && <span className="block text-[10px] text-amber-600">New Material – Master Review Required</span>}
                </td>
                <td className="text-xs">{l.specification || '—'}</td>
                <td>{l.uom || '—'}</td>
                <td>{fmtNum(l.quantity)}</td>
                <td>{l.available_stock == null ? '—' : fmtNum(l.available_stock)}</td>
                <td className="text-xs">{l.remarks || '—'}</td>
                <td>{l.has_attachment
                  ? <button onClick={() => downloadFile(`/prn/${detail.id}/lines/${l.id}/attachment`, l.attachment_name)} className="text-sky-600 hover:underline text-xs">Download</button>
                  : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-700"><History size={15} /> Approval & Status History</div>
      <div className="text-xs text-slate-600 space-y-1">
        {(detail.history || []).length === 0 ? <div className="text-slate-400">No history yet.</div> :
          detail.history.map((h, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-slate-400 w-36 shrink-0">{(h.created_at || '').replace('T', ' ').slice(0, 16)}</span>
              <span className="font-medium w-28 shrink-0">{h.action}</span>
              <span>{h.details}</span>
            </div>
          ))}
      </div>
    </Modal>
  )
}
