import { useEffect, useRef, useState } from 'react'
import { Camera, Image as ImageIcon, Loader2, Plus, RefreshCcw, Send, CheckCircle2, AlertCircle, ScanBarcode, MessageCircle } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Badge, Empty, Loading } from '../components/ui'
import { fmtNum } from '../lib/format'

export default function ProductScan() {
  const [imgB64, setImgB64] = useState('')
  const [imgPreview, setImgPreview] = useState('')
  const [barcodeHint, setBarcodeHint] = useState('')
  const [chat, setChat] = useState([{ role: 'bot', text: "Snap a product or type its name/barcode below. I'll try to identify it." }])
  const [hint, setHint] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const [extras, setExtras] = useState({ standard_rate: '', hsn_code: '', gst_rate: '', weight_per_unit: '' })
  const [cameraOn, setCameraOn] = useState(false)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => () => { stopCamera() }, [])

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraOn(true)
    } catch (e) {
      setChat((c) => [...c, { role: 'bot', text: `Camera blocked: ${e.message}. Use the Upload button instead.` }])
    }
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setCameraOn(false)
  }

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current
    const c = canvasRef.current
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d').drawImage(v, 0, 0)
    const b64 = c.toDataURL('image/jpeg', 0.8).split(',')[1]
    setImgB64(b64)
    setImgPreview(`data:image/jpeg;base64,${b64}`)
    stopCamera()
  }

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => {
      const dataUrl = r.result
      setImgPreview(dataUrl)
      setImgB64(String(dataUrl).split(',')[1])
    }
    r.readAsDataURL(f)
  }

  const send = async (textOverride) => {
    const text = (textOverride ?? hint).trim()
    if (!text && !imgB64 && !barcodeHint) return
    const userMsg = { role: 'me', text: text || (barcodeHint ? `[barcode ${barcodeHint}]` : '[photo]') }
    setChat((c) => [...c, userMsg])
    setHint('')
    setBusy(true)
    setResult(null)
    try {
      const r = await api.post('/products/recognize', {
        image_base64: imgB64 || ' ',
        barcode_hint: barcodeHint,
        text_hint: text,
        notes: text,
        use_ocr: true,
      })
      setResult(r.data)
      const m = r.data.message
      const c = r.data.candidates?.[0]
      setChat((cur) => [...cur, { role: 'bot', text: m + (c ? ` (best: ${c.model} — ${Math.round(c.score * 100)}%)` : '') }])
    } catch (e) {
      setChat((cur) => [...cur, { role: 'bot', text: 'Network error: ' + (e.response?.data?.detail || e.message) }])
    } finally { setBusy(false) }
  }

  const confirmCandidate = async (c) => {
    setConfirming(c)
    setBusy(true)
    try {
      const payload = { ...c, ...(extras.standard_rate ? { standard_rate: Number(extras.standard_rate) } : {}),
                        ...(extras.hsn_code ? { hsn_code: extras.hsn_code } : {}),
                        ...(extras.gst_rate ? { gst_rate: Number(extras.gst_rate) } : {}),
                        ...(extras.weight_per_unit ? { weight_per_unit: Number(extras.weight_per_unit) } : {}) }
      const r = await api.post('/products/recognize/confirm', { candidate: payload, extras })
      setChat((cur) => [...cur, { role: 'bot', text: `${r.data.created ? 'Created' : 'Updated'}: ${r.data.product.model} (${r.data.product.item_code})` }])
      setExtras({ standard_rate: '', hsn_code: '', gst_rate: '', weight_per_unit: '' })
      setConfirming(null)
    } catch (e) {
      setChat((cur) => [...cur, { role: 'bot', text: 'Confirm failed: ' + (e.response?.data?.detail || e.message) }])
    } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader title="Mobile Camera — Product Scan & Chat"
        subtitle="Snap a product (label, box, sticker) + chat with the system to identify it. Then confirm to add it to the catalogue."
        actions={<Badge className="bg-violet-100 text-violet-700">Phase 7 · Mobile OCR</Badge>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="1. Capture / Upload" subtitle="Use camera or pick a photo from the device">
          <div className="space-y-3">
            {cameraOn ? (
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
                <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
                <button onClick={capture} className="absolute bottom-3 left-1/2 -translate-x-1/2 btn btn-primary">
                  <Camera size={16} /> Capture
                </button>
                <button onClick={stopCamera} className="absolute top-2 right-2 btn btn-secondary !py-1 !px-2 text-xs">Stop</button>
              </div>
            ) : imgPreview ? (
              <div className="relative">
                <img src={imgPreview} alt="preview" className="w-full rounded-lg border border-slate-200" />
                <button onClick={() => { setImgB64(''); setImgPreview('') }} className="absolute top-2 right-2 btn btn-secondary !py-1 !px-2 text-xs">
                  <RefreshCcw size={13} /> Retake
                </button>
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-slate-200 p-8 text-center">
                <Camera className="mx-auto text-slate-400 mb-2" size={32} />
                <p className="text-sm text-slate-500 mb-3">No image yet</p>
                <div className="flex items-center justify-center gap-2">
                  <button onClick={startCamera} className="btn btn-primary"><Camera size={15} /> Open camera</button>
                  <button onClick={() => fileRef.current?.click()} className="btn btn-secondary"><ImageIcon size={15} /> Upload</button>
                  <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-slate-500 mb-1">Or scan / type a barcode</label>
              <div className="flex items-center gap-2">
                <input value={barcodeHint} onChange={(e) => setBarcodeHint(e.target.value)}
                  placeholder="e.g. 4040355969110 or STEINEL-HL1620S"
                  className="input flex-1 font-mono" />
                <button onClick={() => send('barcode')} className="btn btn-primary !py-1.5 !px-3 text-sm">
                  <ScanBarcode size={14} /> Lookup
                </button>
              </div>
            </div>
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </Card>

        <Card title="2. Chat" subtitle="Type anything: vendor, model, stock code, HSN, weight, rate"
          actions={<Badge className="bg-blue-100 text-blue-700">{chat.length} msg</Badge>}>
          <div className="h-64 overflow-y-auto bg-slate-50 rounded-lg p-3 space-y-2">
            {chat.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'me' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${m.role === 'me' ? 'bg-amber-500 text-white' : 'bg-white border border-slate-200 text-slate-700'}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> recognizing…</div>}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input value={hint} onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              placeholder='e.g. "Steinel HL 1620 S hot air blower"' className="input flex-1" />
            <button onClick={() => send()} disabled={busy} className="btn btn-primary"><Send size={15} /> Send</button>
          </div>
        </Card>
      </div>

      <Card title="3. Recognition Result" subtitle="Top candidates + decision" className="mt-4"
        actions={result?.matched_product && <Badge className="bg-emerald-100 text-emerald-700"><CheckCircle2 size={12} className="inline mr-1" /> Identified</Badge>}>
        {!result ? <Empty text="Snap or chat to start" icon={MessageCircle} /> : (
          <div className="space-y-3">
            {result.matched_product && (
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-100">
                <div className="text-sm font-semibold text-emerald-800">{result.matched_product.model}</div>
                <div className="text-xs text-emerald-700 mt-1">
                  Code: <span className="font-mono">{result.matched_product.item_code}</span> ·
                  Barcode: <span className="font-mono">{result.matched_product.barcode || '—'}</span> ·
                  Category: {result.matched_product.category} · UoM: {result.matched_product.uom}
                </div>
                {result.matched_product.hsn_code && (
                  <div className="text-xs text-emerald-700">HSN: {result.matched_product.hsn_code} · GST: {result.matched_product.gst_rate}% · Rate: ₹{fmtNum(result.matched_product.standard_rate)}</div>
                )}
              </div>
            )}

            {result.candidates?.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500 uppercase">Candidates ({result.candidates.length})</div>
                {result.candidates.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
                    <div className="h-8 w-8 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center text-sm font-bold">{Math.round(c.score * 100)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{c.model}</div>
                      <div className="text-xs text-slate-500">Code: <span className="font-mono">{c.item_code}</span> · BC: <span className="font-mono">{c.barcode || '—'}</span> · {c.category}</div>
                      <div className="text-xs text-slate-400 italic">{c.reason}</div>
                    </div>
                    <button onClick={() => confirmCandidate(c)} disabled={busy} className="btn btn-primary !py-1 !px-2 text-xs">
                      <Plus size={12} /> {c.product_id ? 'Update' : 'Add'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {result.next_step === 'NEEDS_CONFIRMATION' && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-amber-800 text-sm">
                <AlertCircle size={14} className="inline mr-1" /> Optional fields before adding:
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                  <input value={extras.standard_rate} onChange={(e) => setExtras({ ...extras, standard_rate: e.target.value })}
                    placeholder="Rate ₹" className="input !py-1.5" />
                  <input value={extras.hsn_code} onChange={(e) => setExtras({ ...extras, hsn_code: e.target.value })}
                    placeholder="HSN" className="input !py-1.5" />
                  <input value={extras.gst_rate} onChange={(e) => setExtras({ ...extras, gst_rate: e.target.value })}
                    placeholder="GST %" className="input !py-1.5" />
                  <input value={extras.weight_per_unit} onChange={(e) => setExtras({ ...extras, weight_per_unit: e.target.value })}
                    placeholder="Weight KG" className="input !py-1.5" />
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
