import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Printer, FileText, History, Trash2,
} from 'lucide-react'
import api, { downloadFile } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { PageHeader, Card, Loading } from '../components/ui'
import PrnEditorModal, { lineFromApi } from '../components/PrnEditorModal'
import { fmtNum } from '../lib/format'

export default function PrnDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState({ priorities: [], requirement_types: [], statuses: [] })
  const [departments, setDepartments] = useState([])
  const [materials, setMaterials] = useState([])
  const [locations, setLocations] = useState([])
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    setLoading(true)
    api.get(`/prn/${id}`)
      .then((r) => setDetail(r.data))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    reload()
    api.get('/prn/constants').then((r) => setMeta(r.data)).catch(() => {})
    api.get('/prn/departments').then((r) => setDepartments(r.data || [])).catch(() => {})
    api.get('/prn/materials', { params: { limit: 200 } }).then((r) => setMaterials(r.data || [])).catch(() => {})
    api.get('/prn/locations').then((r) => setLocations(r.data || [])).catch(() => {})
  }, [reload])

  const openEdit = async () => {
    const { data } = await api.get(`/prn/${id}`)
    setEditor({ mode: 'edit', prn: { ...data, lines: (data.lines || []).map(lineFromApi) } })
  }

  const remove = async () => {
    if (!window.confirm(`Delete PRN ${detail.prn_number}? This permanently removes the PRN and cannot be undone.`)) return
    setBusy(true)
    try {
      await api.delete(`/prn/${id}`)
      navigate('/prn')
    } catch (err) {
      alert('Delete failed: ' + (err.response?.data?.detail || err.message))
      setBusy(false)
    }
  }

  const print = async () => {
    try {
      const res = await api.get(`/prn/${id}/pdf`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }))
      const w = window.open(url, '_blank')
      if (!w) { URL.revokeObjectURL(url); downloadFile(`/prn/${id}/pdf`, `${detail?.prn_number || 'PRN'}.pdf`); return }
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (err) {
      if (err.response?.status !== 401) alert('Could not generate PDF: ' + (err.response?.data?.detail || err.message))
    }
  }

  if (loading) return <Loading text="Loading PRN…" />
  if (!detail) {
    return (
      <div className="animate-fade-in-up">
        <PageHeader title="PRN not found" actions={<button onClick={() => navigate('/prn')} className="btn btn-secondary"><ArrowLeft size={15} /> Back</button>} />
      </div>
    )
  }

  const requester = detail.requested_by_id === user?.id
  // No approval workflow: edit/delete follow permission only (requester or admin),
  // and a PRN linked to a purchase order is never deleted.
  const canEdit = requester || isAdmin
  const canDelete = (requester || isAdmin)
    && !(detail.linked_pos && detail.linked_pos.length)

  return (
    <div className="animate-fade-in-up">
      <PageHeader
        crumbs="Purchase Requisition Note"
        title={detail.prn_number}
        subtitle={detail.department || '—'}
        actions={<button onClick={() => navigate('/prn')} className="btn btn-secondary"><ArrowLeft size={15} /> Back to Register</button>}
      />

      <Card className="mb-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="company-name text-lg font-bold text-slate-800">{detail.company_name || 'Kalika Enterprises'}</div>
            <div className="text-xs text-slate-500">Purchase Requisition Note</div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-slate-400">PRN Date</div>{detail.prn_date || '—'}</div>
          <div><div className="text-xs text-slate-400">Department</div>{detail.department || '—'}</div>
          <div><div className="text-xs text-slate-400">Requested By</div>{detail.requested_by_name || '—'}</div>
          <div><div className="text-xs text-slate-400">Required By Date</div>{detail.required_by_date || '—'}</div>
          <div><div className="text-xs text-slate-400">Priority</div>{detail.priority}</div>
          <div><div className="text-xs text-slate-400">Requirement Type</div>{detail.requirement_type}</div>
          <div><div className="text-xs text-slate-400">Department Head</div>{detail.department_head || '—'}</div>
        </div>
      </Card>

      <Card title="Material Requirements" className="mb-5">
        <div className="table-wrap">
          <table className="data-table table-dense">
            <thead><tr>
              <th>Sr. No.</th><th>Item Code</th><th>Material Description</th><th>Specification</th><th>UOM</th>
              <th>Required Qty.</th><th>Inventory Stock</th><th>PRN Stock Override</th><th>Purpose / Remarks</th><th>File</th>
            </tr></thead>
            <tbody>
              {detail.lines.map((l, i) => {
                const inv = l.available_stock == null ? 'Unknown' : fmtNum(l.available_stock)
                return (
                  <tr key={l.id}>
                    <td className="text-xs text-slate-500">{i + 1}</td>
                    <td className="font-mono text-xs">{l.material_code || '—'}</td>
                    <td className="font-medium">
                      {l.description}
                      {l.is_new_material && <span className="block text-[10px] text-amber-600">Manual Entry – Item Master Review Required</span>}
                    </td>
                    <td className="text-xs">{l.specification || '—'}</td>
                    <td>{l.uom || '—'}</td>
                    <td className="text-right">{fmtNum(l.quantity)}</td>
                    <td><span title="Actual inventory at request time (read-only)">{inv}</span>
                      {l.material_id && l.location && <span className="block text-[10px] text-slate-400">{l.location}</span>}</td>
                    <td title="PRN-specific estimate — does not change inventory">
                      {l.stock_override == null
                        ? '—'
                        : <span className="font-semibold text-amber-700">{fmtNum(l.stock_override)}</span>}
                      {l.stock_overridden_by_name && <span className="block text-[10px] text-slate-400">by {l.stock_overridden_by_name}</span>}
                    </td>
                    <td className="text-xs">{l.remarks || '—'}</td>
                    <td>{l.has_attachment
                      ? <button onClick={() => downloadFile(`/prn/${detail.id}/lines/${l.id}/attachment`, l.attachment_name)} className="text-sky-600 hover:underline text-xs">Download</button>
                      : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mb-5">
        {detail.purpose && <div className="text-sm mb-4"><span className="text-xs text-slate-400 block">Purpose of Requisition</span>{detail.purpose}</div>}
        {detail.purchase_remarks && <div className="text-sm mb-4"><span className="text-xs text-slate-400 block">Purchase Department Remarks</span>{detail.purchase_remarks}</div>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
          <div><div className="text-xs text-slate-400">Checked By (Store)</div>{detail.checked_by_name || '—'}</div>
          <div><div className="text-xs text-slate-400">Purchase Ref</div>{detail.purchase_reference || '—'}</div>
        </div>

        <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-700"><History size={15} /> Activity History</div>
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
      </Card>

      <div className="flex items-center justify-end gap-3 border-t border-gray-200 pt-4">
        {canDelete && <button disabled={busy} onClick={remove} className="btn btn-secondary text-red-600 mr-auto"><Trash2 size={15} /> Delete</button>}
        {canEdit && <button onClick={openEdit} className="btn btn-secondary"><FileText size={15} /> Edit</button>}
        <button onClick={print} className="btn btn-primary"><Printer size={15} /> Print</button>
      </div>

      {editor && (
        <PrnEditorModal editor={editor} setEditor={setEditor} meta={meta} departments={departments}
          materials={materials} locations={locations} currentUser={user} onSaved={() => { setEditor(null); reload() }} />
      )}
    </div>
  )
}
