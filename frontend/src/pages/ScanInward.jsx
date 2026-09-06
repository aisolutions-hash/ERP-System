import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Package, History, AlertCircle, CheckCircle2, ScanBarcode } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'
import ScanInput from '../components/ScanInput'

export default function ScanInward() {
  const [lookup, setLookup] = useState(null)
  const [busy, setBusy] = useState(false)
  const [qty, setQty] = useState('')
  const [weight, setWeight] = useState('')
  const [poId, setPoId] = useState('')
  const [recent, setRecent] = useState([])
  const [orders, setOrders] = useState([])
  const [feedback, setFeedback] = useState(null)
  const qtyRef = useRef(null)

  useEffect(() => {
    api.get('/purchases', { params: { status: 'ordered', page_size: 100 } })
      .then((r) => setOrders(r.data.items || []))
      .catch(() => {})
    loadRecent()
  }, [])

  const loadRecent = () => api.get('/barcodes/scan-events', { params: { event_type: 'INWARD', days: 7, page_size: 50 } })
    .then((r) => setRecent(r.data.items || [])).catch(() => [])

  const handleScan = async (barcode) => {
    setBusy(true)
    setFeedback(null)
    try {
      const r = await api.get('/products/lookup', { params: { barcode } })
      setLookup(r.data)
      setTimeout(() => qtyRef.current?.focus(), 100)
    } catch {
      setFeedback({ kind: 'error', msg: 'Network error during lookup' })
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!lookup?.found || !qty) return
    try {
      const body = {
        barcode: lookup.barcode,
        quantity: Number(qty),
        weight_kg: weight ? Number(weight) : null,
        po_id: poId ? Number(poId) : null,
        device_source: 'USB_HID',
      }
      const r = await api.post('/barcodes/scan/inward', body)
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
    { key: 'ref', label: 'Reference', render: (r) => r.ref_type === 'purchase_order' ? `PO#${r.ref_id}` : 'Bare receipt' },
  ]

  return (
    <div>
      <PageHeader title="Scan Inward (Goods Receipt)" subtitle="Scan products to receive against POs or as bare stock. Uses FINGERS QuickScan W5 or any USB HID scanner."
        actions={<Badge className="bg-emerald-100 text-emerald-700">Phase 7 — USB HID</Badge>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="1. Scan barcode" subtitle="Trigger or type — auto-submits" className="lg:col-span-2">
          <ScanInput onScan={handleScan} placeholder="Scan a product barcode…" />
          {busy && <div className="mt-3 text-sm text-slate-500">Looking up…</div>}
        </Card>

        <Card title="Optional: bind to PO" subtitle="Leave empty to auto-match oldest open PO">
          <select value={poId} onChange={(e) => setPoId(e.target.value)} className="input">
            <option value="">Auto-match oldest open PO</option>
            {orders.map((o) => <option key={o.id} value={o.id}>{o.po_number} — {o.supplier?.name}</option>)}
          </select>
          <p className="text-xs text-slate-400 mt-2">When unset, the system picks the oldest open PO line for the scanned product.</p>
        </Card>
      </div>

      <Card title="2. Confirm receipt" subtitle="Enter quantity and optional weight" className="mt-4">
        {!lookup ? (
          <Empty text="Scan a barcode to begin" icon={ScanBarcode} />
        ) : !lookup.found ? (
          <div className="flex items-start gap-3 text-red-600 text-sm">
            <AlertCircle size={18} /> Barcode <span className="font-mono">{lookup.barcode}</span> not found.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 rounded-xl bg-amber-50 border border-amber-100">
              <div className="h-12 w-12 rounded-lg bg-white shadow-sm flex items-center justify-center"><Package className="text-amber-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-slate-800 truncate">{lookup.product.model}</div>
                <div className="text-xs text-slate-500">
                  Item: <span className="font-mono">{lookup.product.item_code}</span> · UoM: {lookup.product.uom} · Category: {lookup.product.category}
                </div>
                <div className="text-xs text-slate-500">
                  Current stock: <span className="font-semibold">{fmtNum(lookup.total_stock)} {lookup.product.uom}</span> · Matched on: {lookup.matched_on}
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
                <button onClick={submit} disabled={!qty} className="btn btn-primary w-full"><ArrowDownToLine size={16} /> Receive</button>
              </div>
            </div>

            {feedback?.kind === 'ok' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm">
                <CheckCircle2 size={16} /> {feedback.msg} — new stock: <span className="font-bold">{fmtNum(feedback.new_stock)}</span>
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

      <Card title="Recent inward scans" subtitle="Last 7 days" className="mt-4"
        actions={<History size={16} className="text-slate-400" />}>
        {recent.length === 0 ? <Empty text="No recent scans" /> : <Table columns={cols} data={recent} keyField="id" dense />}
      </Card>
    </div>
  )
}
