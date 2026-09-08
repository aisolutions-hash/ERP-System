import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import api from '../lib/api'
import { Modal, SearchSelect } from './ui'
import { fmtNum } from '../lib/format'

const today = () => new Date().toISOString().slice(0, 10)
const blankLine = () => ({ product_id: '', description: '', item_code: '', quantity: '' })

function plantOptions(locations) {
  return (locations || []).filter((l) => l.id != null)
}

export function findDispatchPlant(locations) {
  const l = (locations || []).find((x) => x.id != null && String(x.name || '').toLowerCase().includes('dispatch'))
  return l ? l.id : null
}

export default function StockTransferModal({
  open,
  onClose,
  locations = [],
  products = [],
  customers = [],
  invIndex = {},
  initial = null,
  availableFor = null,
  onSaved = null,
}) {
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const nextTransferNo = () => `TR-${today().replace(/-/g, '')}-${Date.now().toString().slice(-4)}`

  useEffect(() => {
    if (open) {
      const init = {
        id: initial?.id ?? null,
        transfer_no: initial?.transfer_no ?? nextTransferNo(),
        from_plant_id: initial?.from_plant_id ?? '',
        to_plant_id: initial?.to_plant_id ?? '',
        customer_id: initial?.customer_id ?? null,
        customer_name: initial?.customer_name ?? '',
        transfer_date: initial?.transfer_date ?? today(),
        notes: initial?.notes ?? '',
        lines: initial?.lines?.length ? initial.lines.map((l) => ({ ...l, product_id: l.product_id ?? '' })) : [blankLine()],
      }
      setForm(init)
      setError(null)
    }
  }, [open, initial]) // eslint-disable-line react-hooks/exhaustive-deps

  const plantOf = (f) => (f?.from_plant_id || '')
  const available = (ln) => {
    if (!ln.product_id) return null
    if (availableFor) {
      const v = availableFor(Number(ln.product_id), plantOf(form))
      if (v != null) return v
    }
    const key = `${Number(ln.product_id)}:${plantOf(form)}`
    return invIndex[key] ?? invIndex[`${Number(ln.product_id)}:`]
  }
  const opts = plantOptions(locations)

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setTLine = (i, k, v) => {
    const lines = [...form.lines]
    lines[i] = { ...lines[i], [k]: v }
    setForm((f) => ({ ...f, lines }))
  }
  const setTLineProduct = (i, id, manual) => {
    const lines = [...form.lines]
    const p = id ? products.find((pp) => pp.id === id) : null
    lines[i] = {
      ...lines[i],
      product_id: id,
      description: id ? lines[i].description : (manual || ''),
      item_code: p ? (lines[i].item_code || p.item_code || '') : (lines[i].item_code || ''),
    }
    setForm((f) => ({ ...f, lines }))
  }

  const save = async () => {
    const payload = {
      transfer_no: form.transfer_no || null,
      from_plant_id: form.from_plant_id !== '' ? Number(form.from_plant_id) : null,
      to_plant_id: form.to_plant_id !== '' ? Number(form.to_plant_id) : null,
      customer_id: form.customer_id ? Number(form.customer_id) : null,
      customer_name: form.customer_name || '',
      transfer_date: form.transfer_date,
      notes: form.notes || '',
      lines: form.lines.filter((l) => l.product_id || (l.description || '').trim())
        .map((l) => ({
          product_id: l.product_id ? Number(l.product_id) : null,
          description: l.description || '', item_code: l.item_code || '',
          quantity: Number(l.quantity || 0),
        })),
    }
    if (payload.to_plant_id == null) { setError('Select the destination location'); return }
    if (payload.lines.length === 0) { setError('Add at least one line'); return }
    setSaving(true)
    try {
      if (form.id) await api.patch(`/inventory/transfers/${form.id}`, payload)
      else await api.post('/inventory/transfers', payload)
      onClose()
      if (onSaved) onSaved()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open title={form?.id ? `Edit Transfer ${form.transfer_no}` : 'Transfer Stock'} onClose={onClose} wide
      footer={<>
        <button onClick={onClose} disabled={saving} className="btn btn-secondary">Cancel</button>
        <button onClick={save} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : form?.id ? 'Save Changes' : 'Create Transfer'}</button>
      </>}>
      {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
      {form && (<>
        <div className="grid grid-cols-2 gap-3 text-sm mb-3">
          <div><label className="block text-slate-500 text-xs mb-1">Transfer No</label>
            <input value={form.transfer_no || ''} onChange={(e) => setField('transfer_no', e.target.value)} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Date</label>
            <input type="date" value={form.transfer_date} onChange={(e) => setField('transfer_date', e.target.value)} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">From Location *</label>
            <select value={form.from_plant_id ?? ''} onChange={(e) => setField('from_plant_id', e.target.value)} className="input">
              <option value="">Main Store</option>
              {opts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">To Location *</label>
            <select value={form.to_plant_id ?? ''} onChange={(e) => setField('to_plant_id', e.target.value)} className="input">
              <option value="">Select…</option>
              {opts.filter((l) => String(l.id) !== String(form.from_plant_id ?? '')).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></div>
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Customer <span className="text-slate-400">(optional, reference only)</span></label>
            <SearchSelect
              options={customers.map((c) => ({ id: c.id, label: c.name }))}
              value={form.customer_id || null}
              initialLabel={!form.customer_id ? (form.customer_name || '') : ''}
              placeholder="Type to search customer or enter a name"
              onChange={(id, manual) => setForm((f) => ({ ...f, customer_id: id, customer_name: manual }))}
            /></div>
          <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Notes</label>
            <input value={form.notes || ''} onChange={(e) => setField('notes', e.target.value)} className="input" /></div>
        </div>

        <div className="mb-1 text-xs font-medium text-slate-500 uppercase">Transfer Lines</div>
        <div className="hidden sm:grid grid-cols-12 gap-2 items-center text-[10px] uppercase tracking-wide text-slate-400 mb-1 px-1">
          <div className="col-span-5">Product / Manual Item</div>
          <div className="col-span-2">Item Code</div>
          <div className="col-span-2">Available</div>
          <div className="col-span-2">Qty</div>
          <div className="col-span-1" />
        </div>
        <div className="space-y-2">
          {form.lines.map((ln, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
              <SearchSelect
                options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                value={ln.product_id || null}
                initialLabel={!ln.product_id ? (ln.description || '') : ''}
                placeholder="Product or manual item…"
                className="input col-span-5 py-1.5"
                onChange={(id, manual) => setTLineProduct(i, id || '', manual)}
              />
              <input value={ln.item_code ?? ''} onChange={(e) => setTLine(i, 'item_code', e.target.value)} placeholder="e.g. LAP-001" className="input col-span-2 py-1.5" />
              <span className="col-span-2 text-slate-400">{available(ln) != null ? fmtNum(available(ln)) : '—'}</span>
              <input value={ln.quantity ?? ''} type="number" onChange={(e) => setTLine(i, 'quantity', e.target.value)} placeholder="Qty" className="input col-span-2 py-1.5" />
              <button onClick={() => { if (form.lines.length > 1) setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) })) }} className="col-span-1 text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <button onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, blankLine()] }))} className="btn btn-ghost mt-2 text-xs"><Plus size={12} className="inline mr-1" />Add line</button>
      </>)}
    </Modal>
  )
}