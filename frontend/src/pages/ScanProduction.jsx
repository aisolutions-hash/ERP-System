import { useEffect, useRef, useState } from 'react'
import { Factory, History, AlertCircle, CheckCircle2, ScanBarcode } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'
import ScanInput from '../components/ScanInput'

export default function ScanProduction() {
  const [lookup, setLookup] = useState(null)
  const [qty, setQty] = useState('')
  const [poId, setPoId] = useState('')
  const [orders, setOrders] = useState([])
  const [recent, setRecent] = useState([])
  const [feedback, setFeedback] = useState(null)
  const qtyRef = useRef(null)

  useEffect(() => {
    api.get('/production', { params: { page_size: 100 } })
      .then((r) => setOrders(r.data.items || []))
      .catch(() => {})
    loadRecent()
  }, [])

  const loadRecent = () => api.get('/barcodes/scan-events', { params: { event_type: 'PRODUCTION', days: 7, page_size: 50 } })
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
      const r = await api.post('/barcodes/scan/production', {
        barcode: lookup.barcode,
        quantity: Number(qty),
        production_order_id: poId ? Number(poId) : null,
        device_source: 'USB_HID',
      })
      setFeedback({ kind: 'ok', msg: r.data.message, new_stock: r.data.new_stock })
      setLookup(null); setQty('')
      loadRecent()
    } catch (e) {
      setFeedback({ kind: 'error', msg: e.response?.data?.detail || 'Scan failed' })
    }
  }

  const cols = [
    { key: 'scanned_at', label: 'Time', render: (r) => r.scanned_at?.slice(11, 19) || '—' },
    { key: 'barcode', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.barcode_value}</span> },
    { key: 'qty', label: 'Produced', render: (r) => <span className="font-semibold">{fmtNum(r.quantity)}</span> },
    { key: 'ref', label: 'Production Order', render: (r) => r.ref_type === 'production_order' ? `PO#${r.ref_id}` : '—' },
  ]

  return (
    <div>
      <PageHeader title="Scan Production Output" subtitle="Scan finished-goods barcode to record daily production output. Auto-matches the active production order."
        actions={<Badge className="bg-violet-100 text-violet-700">Phase 7 — USB HID</Badge>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="1. Scan finished-goods barcode" subtitle="Code128 / EAN / QR" className="lg:col-span-2">
          <ScanInput onScan={handleScan} placeholder="Scan finished-goods barcode…" />
        </Card>

        <Card title="Optional: bind to production order" subtitle="Leave empty to auto-match">
          <select value={poId} onChange={(e) => setPoId(e.target.value)} className="input">
            <option value="">Auto-match active order</option>
            {orders.map((o) => <option key={o.id} value={o.id}>{o.order_no} — {o.product?.model} ({fmtNum(o.schedule_qty)})</option>)}
          </select>
        </Card>
      </div>

      <Card title="2. Record output" subtitle="Quantity produced" className="mt-4">
        {!lookup ? (
          <Empty text="Scan a finished-goods barcode" icon={ScanBarcode} />
        ) : !lookup.found ? (
          <div className="flex items-start gap-3 text-red-600 text-sm">
            <AlertCircle size={18} /> Barcode <span className="font-mono">{lookup.barcode}</span> not found.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 rounded-xl bg-violet-50 border border-violet-100">
              <div className="h-12 w-12 rounded-lg bg-white shadow-sm flex items-center justify-center"><Factory className="text-violet-600" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-slate-800 truncate">{lookup.product.model}</div>
                <div className="text-xs text-slate-500">
                  Item: <span className="font-mono">{lookup.product.item_code}</span> · UoM: {lookup.product.uom}
                </div>
                <div className="text-xs text-slate-500">
                  Category: <span className="font-semibold">{lookup.product.category}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Produced qty ({lookup.product.uom})</label>
                <input ref={qtyRef} type="number" value={qty} onChange={(e) => setQty(e.target.value)} className="input" placeholder="0" />
              </div>
              <div className="flex items-end">
                <button onClick={submit} disabled={!qty} className="btn btn-primary w-full"><Factory size={16} /> Record Output</button>
              </div>
            </div>

            {feedback?.kind === 'ok' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm">
                <CheckCircle2 size={16} /> {feedback.msg} — FG stock: <span className="font-bold">{fmtNum(feedback.new_stock)}</span>
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

      <Card title="Recent production scans" subtitle="Last 7 days" className="mt-4"
        actions={<History size={16} className="text-slate-400" />}>
        {recent.length === 0 ? <Empty text="No recent scans" /> : <Table columns={cols} data={recent} keyField="id" dense />}
      </Card>
    </div>
  )
}
