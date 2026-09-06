import { useEffect, useState } from 'react'
import { Printer, Download, Send, Settings, Barcode, Activity, ExternalLink, Database } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Empty, Badge, Modal, Loading } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'
import ScanInput from '../components/ScanInput'

export default function Labels() {
  const [products, setProducts] = useState([])
  const [printers, setPrinters] = useState([])
  const [selected, setSelected] = useState(null)
  const [qty, setQty] = useState(1)
  const [weight, setWeight] = useState('')
  const [copies, setCopies] = useState(1)
  const [printerId, setPrinterId] = useState('')
  const [workstation, setWorkstation] = useState('DEFAULT')
  const [preview, setPreview] = useState(null)
  const [printResult, setPrintResult] = useState(null)
  const [showPrinters, setShowPrinters] = useState(false)
  const [selftestResult, setSelftestResult] = useState(null)
  const [selftestBusy, setSelftestBusy] = useState(false)
  const [gcsFiles, setGcsFiles] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadProducts(); loadPrinters(); loadGcs()
  }, [])

  const loadProducts = () => api.get('/products', { params: { page_size: 500 } })
    .then((r) => setProducts(r.data.items || [])).catch(() => [])

  const loadPrinters = () => api.get('/barcodes/printers').then((r) => {
    setPrinters(r.data.items || [])
    const def = (r.data.items || []).find((p) => p.is_default) || (r.data.items || [])[0]
    if (def) setPrinterId(def.id)
  }).catch(() => {})

  const loadGcs = () => api.get('/barcodes/gcs/list', { params: { prefix: 'labels/', limit: 20 } })
    .then((r) => setGcsFiles(r.data.items || [])).catch(() => [])

  const runSelftest = async () => {
    setSelftestBusy(true)
    try {
      const r = await api.get('/barcodes/selftest')
      setSelftestResult(r.data)
      loadGcs()
    } catch (e) {
      setSelftestResult({ ok: false, error: e.response?.data?.detail || e.message })
    } finally { setSelftestBusy(false) }
  }

  const handleScan = async (barcode) => {
    const r = await api.get('/products/lookup', { params: { barcode } })
    if (r.data.found) {
      setSelected(r.data.product)
      setPreview(null)
    }
  }

  const doPreview = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const r = await api.post('/barcodes/label/preview', {
        product_id: selected.id, quantity: Number(qty),
        weight_kg: weight ? Number(weight) : null,
        copies: Number(copies), printer_id: printerId || null,
        workstation,
      })
      setPreview(r.data)
    } finally { setBusy(false) }
  }

  const doDownload = async () => {
    if (!selected) return
    const r = await api.post('/barcodes/label/download', {
      product_id: selected.id, quantity: Number(qty),
      weight_kg: weight ? Number(weight) : null,
      copies: Number(copies), printer_id: printerId || null,
      workstation,
    }, { responseType: 'blob' })
    const url = URL.createObjectURL(new Blob([r.data], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `label_${selected.item_code || selected.id}.${preview?.protocol?.toLowerCase() || 'txt'}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const doPrint = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const r = await api.post('/barcodes/label/print', {
        product_id: selected.id, quantity: Number(qty),
        weight_kg: weight ? Number(weight) : null,
        copies: Number(copies), printer_id: printerId || null,
        workstation,
      })
      setPrintResult(r.data)
    } finally { setBusy(false) }
  }

  const productCols = [
    { key: 'model', label: 'Model', render: (r) => <span className="font-medium">{r.model}</span> },
    { key: 'item_code', label: 'Item', render: (r) => <span className="font-mono text-xs">{r.item_code}</span> },
    { key: 'barcode', label: 'Barcode', render: (r) => <span className="font-mono text-xs">{r.barcode || '—'}</span> },
    { key: 'hsn', label: 'HSN', render: (r) => r.hsn_code || '—' },
    { key: 'rate', label: 'Rate', render: (r) => r.standard_rate ? `₹${fmtNum(r.standard_rate)}` : '—' },
    {
      key: 'sel', label: '', render: (r) => (
        <button onClick={() => { setSelected(r); setPreview(null) }} className="btn btn-primary !py-1 !px-2 text-xs">
          Select
        </button>
      )
    },
  ]

  return (
    <div>
      <PageHeader title="Print Labels (TSC TTP series)"
        subtitle="Generate TSPL/ZPL/ESCPOS labels. Works with TSC TTP-244 Pro, TTP-247, TTP-345 and any ZPL printer."
        actions={
          <>
            <button onClick={() => setShowPrinters(true)} className="btn btn-secondary">
              <Settings size={15} /> Printers ({printers.length})
            </button>
            <Badge className="bg-violet-100 text-violet-700">Phase 7</Badge>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="1. Pick a product" subtitle="Scan barcode or select" className="lg:col-span-2">
          <ScanInput onScan={handleScan} placeholder="Scan to load product…" />
          <div className="mt-4 max-h-72 overflow-y-auto">
            <Table columns={productCols} data={products.slice(0, 50)} keyField="id" dense stickyColumns={['model']} />
          </div>
        </Card>

        <Card title="2. Label options" subtitle="Set quantity, copies & target printer">
          {selected ? (
            <div className="space-y-3 text-sm">
              <div className="p-3 rounded-lg bg-violet-50 border border-violet-100">
                <div className="font-semibold">{selected.model}</div>
                <div className="text-xs text-slate-500">Item: <span className="font-mono">{selected.item_code}</span> · Barcode: <span className="font-mono">{selected.barcode || '—'}</span></div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Quantity (label)</label>
                <input type="number" min="0" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)} className="input" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Weight (KG, optional)</label>
                <input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} className="input" placeholder="0.000" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Copies</label>
                <input type="number" min="1" max="100" value={copies} onChange={(e) => setCopies(e.target.value)} className="input" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Workstation</label>
                <input value={workstation} onChange={(e) => setWorkstation(e.target.value)} className="input" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Printer</label>
                <select value={printerId} onChange={(e) => setPrinterId(e.target.value)} className="input">
                  <option value="">Default (auto)</option>
                  {printers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.protocol})</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-2 pt-2">
                <button onClick={doPreview} disabled={busy} className="btn btn-secondary"><Barcode size={15} /> Preview</button>
                <button onClick={doPrint} disabled={busy} className="btn btn-primary"><Send size={15} /> Print</button>
                <button onClick={doDownload} className="btn btn-secondary"><Download size={15} /> Download</button>
              </div>
            </div>
          ) : <Empty text="Select a product first" icon={Printer} />}
        </Card>
      </div>

      {preview && (
        <Card title={`Preview — ${preview.protocol} → ${preview.printer}`}
          subtitle={`${preview.label_size_mm[0]} mm × ${preview.label_size_mm[1]} mm · ${preview.copies}× copies`}
          className="mt-4"
          actions={<Badge className="bg-emerald-100 text-emerald-700">{preview.barcode_value}</Badge>}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 font-mono text-xs whitespace-pre overflow-auto max-h-72">
              {preview.text}
            </div>
            <div>
              <LabelPreviewSvg product={selected} barcodeValue={preview.barcode_value} />
            </div>
          </div>
        </Card>
      )}

      {printResult && (
        <Card title="Print result" className="mt-4">
          <div className="space-y-2 text-sm">
            <div>
              Route: <Badge className={printResult.route.includes('SENT') || printResult.route === 'SPOOLED' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>{printResult.route}</Badge>
              {' '}Bytes: {printResult.bytes} · Copies: {printResult.copies}
            </div>
            {printResult.spool_path && (
              <div className="text-xs text-slate-500">
                Spooled to: <span className="font-mono">{printResult.spool_path}</span>
                <div className="text-slate-400 mt-1">→ Configure TSC Windows driver to auto-print from this folder.</div>
              </div>
            )}
            {printResult.gcs_uri && (
              <div className="text-xs text-slate-500">
                Archived: <span className="font-mono">{printResult.gcs_uri}</span>
                <div className="text-slate-400 mt-1">→ gs://kalika_enterprises secured bucket (audit trail).</div>
              </div>
            )}
            {printResult.error && <div className="text-red-600 mt-2">Error: {printResult.error}</div>}
          </div>
        </Card>
      )}

      <Modal open={showPrinters} title="Printer Workstations" onClose={() => setShowPrinters(false)} wide
        footer={<button onClick={() => setShowPrinters(false)} className="btn btn-secondary">Close</button>}>
        <p className="text-sm text-slate-500 mb-3">Each workstation can have one default printer. Backend falls back to the first active printer if no default is found.</p>
        <Table
          columns={[
            { key: 'name', label: 'Printer', render: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'workstation', label: 'Workstation' },
            { key: 'protocol', label: 'Protocol', render: (r) => <Badge>{r.protocol}</Badge> },
            { key: 'connection', label: 'Connection' },
            { key: 'size', label: 'Label', render: (r) => `${r.label_width_mm}×${r.label_height_mm}mm @${r.dpi}dpi` },
            { key: 'def', label: 'Default', render: (r) => r.is_default ? <Badge className="bg-emerald-100 text-emerald-700">Yes</Badge> : '—' },
          ]}
          data={printers} keyField="id" dense
        />
      </Modal>

      {/* End-to-end self-test + GCS archive (FINGERS + TTP-247 pipeline) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
        <Card title="End-to-end self-test" subtitle="Verifies lookup → label build → spool → GCS archive → audit"
          actions={<button onClick={runSelftest} disabled={selftestBusy} className="btn btn-primary !py-1 !px-2 text-xs"><Activity size={14} /> {selftestBusy ? 'Running…' : 'Run test'}</button>}>
          {selftestBusy ? <Loading /> : !selftestResult ? (
            <p className="text-sm text-slate-500">Click <strong>Run test</strong> to validate the entire barcode + TSC print pipeline without a real scanner or printer.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge className={selftestResult.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                  {selftestResult.ok ? 'ALL OK' : 'PARTIAL'}
                </Badge>
                <span className="text-xs text-slate-400">{selftestResult.ran_at}</span>
              </div>
              {selftestResult.product && (
                <div className="text-xs text-slate-500">Product: <span className="font-mono">{selftestResult.product.item_code}</span> ({selftestResult.product.model})</div>
              )}
              {selftestResult.printer && (
                <div className="text-xs text-slate-500">Printer: <span className="font-mono">{selftestResult.printer.name}</span> · {selftestResult.printer.protocol}/{selftestResult.printer.connection}</div>
              )}
              <div className="mt-2 space-y-1">
                {(selftestResult.steps || []).map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={s.ok ? 'text-emerald-500' : 'text-red-500'}>{s.ok ? '✓' : '✗'}</span>
                    <span className="font-medium">{s.step}</span>
                    {s.error && <span className="text-red-600 truncate">— {s.error}</span>}
                    {s.path && <span className="text-slate-500 truncate font-mono">— {s.path.split(/[\\/]/).pop()}</span>}
                    {s.uri && <span className="text-slate-500 truncate font-mono">— {s.uri.split('/').pop()}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card title="Secured info archive (kalika_enterprises)" subtitle="gs://kalika_enterprises/labels/ — last 20 files"
          actions={<button onClick={loadGcs} className="btn btn-secondary !py-1 !px-2 text-xs"><Database size={14} /> Refresh</button>}>
          {gcsFiles.length === 0 ? (
            <p className="text-sm text-slate-500">No files yet. Run the self-test to push the first one.</p>
          ) : (
            <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {gcsFiles.map((f) => (
                <div key={f.name} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 text-xs">
                  <Database size={13} className="text-blue-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono truncate">{f.name}</div>
                    <div className="text-slate-400">{(f.size / 1024).toFixed(1)} KB · {f.updated?.slice(0, 16)}</div>
                  </div>
                  <a href={f.uri} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700 shrink-0"><ExternalLink size={13} /></a>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function LabelPreviewSvg({ product, barcodeValue }) {
  // Render a simple SVG preview using a placeholder barcode pattern (frontend
  // can swap to JsBarcode / qrcode.js without changing backend)
  const bars = (barcodeValue || '0000000000000').padEnd(13, '0').split('')
    .map((c, i) => ({ x: 20 + i * 12, w: 4 + (parseInt(c) % 7) * 2 }))
  return (
    <svg viewBox="0 0 240 120" className="w-full h-auto bg-white border border-slate-200 rounded-lg">
      <rect x="0" y="0" width="240" height="120" fill="white" />
      <text x="120" y="14" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#0f172a">KALIKA ENTERPRISES</text>
      <line x1="10" y1="20" x2="230" y2="20" stroke="#cbd5e1" strokeWidth="1" />
      <text x="14" y="34" fontSize="9" fontFamily="monospace" fill="#475569">Model: {(product?.model || '').slice(0, 24)}</text>
      <text x="14" y="46" fontSize="9" fontFamily="monospace" fill="#475569">Item: {product?.item_code}</text>
      {bars.map((b, i) => <rect key={i} x={b.x} y="55" width={b.w} height="35" fill="#0f172a" />)}
      <text x="120" y="100" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#0f172a">{barcodeValue}</text>
      <text x="14" y="112" fontSize="8" fontFamily="monospace" fill="#475569">HSN: {product?.hsn_code || '-'}</text>
    </svg>
  )
}
