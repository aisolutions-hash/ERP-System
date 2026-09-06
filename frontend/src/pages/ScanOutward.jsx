import { useEffect, useRef, useState } from 'react'
import { ArrowUpFromLine, Package, History, AlertCircle, CheckCircle2, ScanBarcode } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'
import ScanInput from '../components/ScanInput'

export default function ScanOutward() {
  const [lookup, setLookup] = useState(null)
  const [qty, setQty] = useState('')
  const [weight, setWeight] = useState('')
  const [dispatchId, setDispatchId] = useState('')
  const [recent, setRecent] = useState([])
  const [dispatches, setDispatches] = useState([])
  const [feedback, setFeedback] = useState(null)
  const qtyRef = useRef(null)

  useEffect(() => {
    api.get('/dispatch', { params: { page_size: 50 } })
      .then((r) => setDispatches(r.data.items || []))
      .catch(() => {})
    loadRecent()
  }, [])

  const loadRecent = () => api.get('/barcodes/scan-events', { params: { event_type: 'OUTWARD', days: 7, page_size: 50 } })
    .then((r) => setRecent(r.data.items || [])).catch(() => [])

  const handleScan = async (barcode) => {
    setFeedback(null)
    try {
      const r = await api.get('/products/lookup', { params: { barcode } })
      setLookup(r.data)
      setTimeout(() => qtyRef.current?.focus(), 100)
    } catch {
      setFeedback({ kind: 'error', msg: 'Network error during lookup' })
    }
  }

  const submit = async () => {
    if (!lookup?.found || !qty) return
    try {
      const r = await api.post('/barcodes/scan/outward', {
        barcode: lookup.barcode,
        quantity: Number(qty),
        weight_kg: weight ? Number(weight) : null,
        dispatch_id: dispatchId ? Number(dispatchId) : null,
        device_source: 'USB_HID',
      })
      setFeedback({ kind: 'ok', msg: r.data.message, new_stock: r.data.new_stock })
      setLookup(null); setQty(''); setWeight('')
      loadRecent()
    } catch (e) {
      setFeedback({ kind: 'error', msg: e.response?.data?.detail || 'Scan failed' })
    }
  }

  const cols = [
    { key: 'scanned_at', label: 'Time', render: (r) => r.scanned_at?.slice(11, 19) || '—' },
    { key: 'barcode', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.barcode_value}</span> },
    { key: 'qty', label: 'Qty', render: (r) => <span className="font-semibold">{fmtNum(r.quantity)}</span> },
    { key: 'weight', label: 'Weight', render: (r) => r.weight_kg != null ? `${fmtNum(r.weight_kg)} KG` : '—' },
    { key: 'ref', label: 'Reference', render: (r) => r.ref_type === 'dispatch' ? `Dispatch#${r.ref_id}` : 'Bare issue' },
  ]

  return (
    <div>
      <PageHeader title="Scan Outward (Dispatch / Issue)" subtitle="Scan products to dispatch against a customer order or record a bare issue."
        actions={<Badge className="bg-cyan-100 text-cyan-700">Phase 7 — USB HID</Badge>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="1. Scan barcode" subtitle="Trigger or type — auto-submits" className="lg:col-span-2">
          <ScanInput onScan={handleScan} placeholder="Scan a product barcode…" />
        </Card>

        <Card title="Optional: bind to dispatch" subtitle="Leave empty for bare issue / consumption">
          <select value={dispatchId} onChange={(e) => setDispatchId(e.target.value)} className="input">
            <option value="">Bare issue (no dispatch)</option>
            {dispatches.map((d) => <option key={d.id} value={d.id}>{d.dispatch_no} — {d.customer?.name || 'no customer'}</option>)}
          </select>
        </Card>
      </div>

      <Card title="2. Confirm dispatch" subtitle="Enter quantity and optional weight" className="mt-4">
        {!lookup ? (
          <Empty text="Scan a barcode to begin" icon={ScanBarcode} />
        ) : !lookup.found ? (
          <div className="flex items-start gap-3 text-red-600 text-sm">
            <AlertCircle size={18} /> Barcode <span className="font-mono">{lookup.barcode}</span> not found.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 rounded-xl bg-cyan-50 border border-cyan-100">
              <div className="h-12 w-12 rounded-lg bg-white shadow-sm flex items-center justify-center"><Package className="text-cyan-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-slate-800 truncate">{lookup.product.model}</div>
                <div className="text-xs text-slate-500">
                  Item: <span className="font-mono">{lookup.product.item_code}</span> · UoM: {lookup.product.uom}
                </div>
                <div className="text-xs text-slate-500">
                  Available: <span className="font-semibold">{fmtNum(lookup.total_stock)} {lookup.product.uom}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Quantity ({lookup.product.uom})</label>
                <input ref={qtyRef} type="number" value={qty} onChange={(e) => setQty(e.target.value)} className="input" placeholder="0" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Weight (KG, optional)</label>
                <input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} className="input" placeholder="0.000" />
              </div>
              <div className="flex items-end">
                <button onClick={submit} disabled={!qty} className="btn btn-primary w-full"><ArrowUpFromLine size={16} /> Dispatch</button>
              </div>
            </div>

            {feedback?.kind === 'ok' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm">
                <CheckCircle2 size={16} /> {feedback.msg} — remaining stock: <span className="font-bold">{fmtNum(feedback.new_stock)}</span>
              </div>
            )}
            {feedback?.kind === 'error' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm">
                <AlertCircle size={16} /> {feedback.msg}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="Recent outward scans" subtitle="Last 7 days" className="mt-4"
        actions={<History size={16} className="text-slate-400" />}>
        {recent.length === 0 ? <Empty text="No recent scans" /> : <Table columns={cols} data={recent} keyField="id" dense />}
      </Card>
    </div>
  )
}
