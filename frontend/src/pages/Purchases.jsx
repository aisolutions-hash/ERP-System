import { useEffect, useState } from 'react'
import { Plus, Search, Download, Eye, Pencil, Trash2, RefreshCw, PackageOpen, FilePlus2, DollarSign, Layers, CheckCircle2, Share2, Printer, Image } from 'lucide-react'
import html2canvas from 'html2canvas'
import api, { downloadFile } from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard, SearchSelect } from '../components/ui'
import Table from '../components/Table'
import { fmtNum } from '../lib/format'

const statusCls = {
  Draft: 'bg-gray-100 text-gray-600',
  Ordered: 'bg-cyan-100 text-cyan-700',
  'Partially Received': 'bg-amber-100 text-amber-700',
  Received: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-600',
}
const statuses = ['Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled']

export default function Purchases() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [receiveQty, setReceiveQty] = useState({})
  const [receiveBusy, setReceiveBusy] = useState(false)
  const [receiveErr, setReceiveErr] = useState(null)
  const [receiveMsg, setReceiveMsg] = useState(null)
  const [importFile, setImportFile] = useState(null)
  const [importResult, setImportResult] = useState(null)
  const [importBusy, setImportBusy] = useState(false)
  const [suppliers, setSuppliers] = useState([])
  const [products, setProducts] = useState([])
  const [form, setForm] = useState({ lines: [] })
  const [error, setError] = useState(null)

  const calcLine = (ln) => {
    const q = Number(ln.quantity || 0)
    const r = Number(ln.rate || 0)
    const basic = q * r
    const discPct = Number(ln.discount_percent || 0)
    const discount = basic * discPct / 100
    const taxable = basic - discount
    const taxPct = Number(ln.tax_percent || 0)
    const gst = taxable * taxPct / 100
    const total = taxable + gst
    return { basic, discount, taxable, gst, total }
  }

  const load = () => {
    setLoading(true)
    api.get('/purchases', { params: { search } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t) }, [search])
  useEffect(() => {
    api.get('/suppliers', { params: { page_size: 500 } }).then((r) => setSuppliers(r.data.items || [])).catch(() => {})
    api.get('/products', { params: { page_size: 500 } }).then((r) => setProducts(r.data.items || [])).catch(() => {})
  }, [])

  const openNew = () => {
    setForm({
      po_number: '', order_date: new Date().toISOString().slice(0, 10), status: 'Ordered', notes: '',
      supplier_id: '', supplier_name: '', supplier_gstin: '', supplier_address: '', supplier_phone: '', supplier_email: '',
      lines: [{ product_id: '', description: '', item_code: '', quantity: '', received_qty: 0, rate: '', amount: '', uom: '', tax_percent: null, discount_percent: null }],
    })
    setError(null); setShowForm(true)
  }

  const openEdit = (po) => {
    setForm({
      id: po.id, po_number: po.po_number, supplier_id: po.supplier_id ?? '',
      supplier_name: po.supplier?.name || po.supplier_name || '',
      supplier_gstin: po.supplier?.gstin || '',
      supplier_address: po.supplier?.address || '',
      supplier_phone: po.supplier?.phone || '',
      supplier_email: po.supplier?.email || '',
      order_date: po.order_date, status: po.status, notes: po.notes || '',
      lines: (po.lines || []).map((l) => ({ id: l.id, product_id: l.product_id ?? '', description: l.description || '', item_code: l.item_code || '', quantity: l.quantity, received_qty: l.received_qty || 0, rate: l.rate ?? '', amount: l.amount ?? '', uom: l.uom || '', tax_percent: l.tax_percent ?? null, discount_percent: l.discount_percent ?? null })),
    })
    setError(null); setShowForm(true)
  }

  const setLine = (i, k, v) => {
    const lines = [...form.lines]
    lines[i] = { ...lines[i], [k]: v }
    if (k === 'quantity' || k === 'rate' || k === 'tax_percent' || k === 'discount_percent') {
      lines[i].amount = calcLine(lines[i]).total
    }
    setForm({ ...form, lines })
  }

  const setLineProduct = (i, id, manual) => {
    const lines = [...form.lines]
    const p = id ? products.find((pp) => pp.id === id) : null
    lines[i] = {
      ...lines[i],
      product_id: id,
      description: id ? lines[i].description : (manual || ''),
      item_code: p ? (lines[i].item_code || p.item_code || '') : (lines[i].item_code || (id ? '' : '')),
      uom: lines[i].uom || p?.uom || '',
    }
    lines[i].amount = calcLine(lines[i]).total
    setForm({ ...form, lines })
  }

  const setSupplier = (id, manual) => {
    const s = id ? suppliers.find((ss) => ss.id === id) : null
    setForm({
      ...form,
      supplier_id: id || '',
      supplier_name: s ? s.name : (manual || ''),
      supplier_gstin: s ? (s.gstin || '') : '',
      supplier_address: s ? (s.address || '') : '',
      supplier_phone: s ? (s.phone || '') : '',
      supplier_email: s ? (s.email || '') : '',
    })
  }

  const save = async () => {
    const payload = {
      po_number: form.po_number,
      supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
      supplier_name: (form.supplier_name || '').trim(),
      supplier_gstin: (form.supplier_gstin || '').trim(),
      supplier_address: (form.supplier_address || '').trim(),
      supplier_phone: (form.supplier_phone || '').trim(),
      supplier_email: (form.supplier_email || '').trim(),
      order_date: form.order_date, status: form.status || 'Ordered', notes: form.notes || '',
      lines: form.lines.filter((l) => l.product_id || (l.description || '').trim()).map((l) => ({
        product_id: l.product_id ? Number(l.product_id) : null,
        description: l.description || '',
        item_code: l.item_code || '',
        quantity: Number(l.quantity || 0), received_qty: Number(l.received_qty || 0),
        rate: l.rate !== '' && l.rate != null ? Number(l.rate) : null,
        amount: l.amount !== '' && l.amount != null ? Number(l.amount) : null,
        uom: l.uom || '',
        tax_percent: l.tax_percent ?? null,
        discount_percent: l.discount_percent ?? null,
      })),
    }
    if (!payload.po_number) { setError('PO number is required'); return }
    if (!payload.supplier_id && !payload.supplier_name) { setError('Select or type a supplier'); return }
    if (payload.lines.length === 0) { setError('Add at least one line'); return }
    try {
      if (form.id) {
        await api.patch(`/purchases/${form.id}`, payload)
        if (detail) openDetail({ id: detail.id, po_number: detail.po_number })
      } else {
        const r = await api.post('/purchases', payload)
        setDetail(r.data)
      }
      setShowForm(false); setForm({ lines: [] }); setError(null); load()
    } catch (e) { setError(e.response?.data?.detail || 'Save failed') }
  }

  const del = async (po) => {
    if (!confirm(`Delete PO ${po.po_number}?`)) return
    try {
      await api.delete(`/purchases/${po.id}`)
      setDetail(null)
      load()
    } catch (e) { alert('Delete failed: ' + (e.response?.data?.detail || e.message)) }
  }

  const openDetail = (po) => {
    setDetail({ id: po.id, po_number: po.po_number, loading: true })
    setReceiveQty({})
    setReceiveErr(null)
    setReceiveMsg(null)
    setDetailLoading(true)
    api.get(`/purchases/${po.id}`)
      .then((res) => setDetail(res.data))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }

  // ---- PO document HTML builder (reused for PDF print and JPG export) ----
  const receiveLine = async (line) => {
    if (!detail || detail.loading) return
    const receiveNow = Number(receiveQty[line.id] || 0)
    const already = Number(line.received_qty || 0)
    const remaining = Number(line.quantity || 0) - already
    if (!(receiveNow > 0)) { setReceiveErr(`Enter the quantity received for: ${line.description || line.item_code || 'this line'}`); return }
    if (receiveNow > remaining) { setReceiveErr(`Cannot receive ${receiveNow} — only ${remaining} remaining on this line`); return }
    setReceiveBusy(true); setReceiveErr(null); setReceiveMsg(null)
    try {
      const { data } = await api.post(`/purchases/${detail.id}/receive`, null, {
        params: { line_id: line.id, received_qty: already + receiveNow },
      })
      setDetail(data)
      setReceiveQty((q) => ({ ...q, [line.id]: '' }))
      setReceiveMsg(`Received ${receiveNow} → cumulative ${already + receiveNow}`)
      setTimeout(() => setReceiveMsg(null), 3000)
      load()
    } catch (e) {
      setReceiveErr(e.response?.data?.detail || 'Receive failed')
    } finally { setReceiveBusy(false) }
  }

  const buildPoHtml = (d) => {
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const lineRows = (d.lines || []).map((l) => {
      const pending = Math.max((Number(l.quantity) || 0) - (Number(l.received_qty) || 0), 0)
      return `<tr>` +
        `<td>${escHtml(l.product?.model || l.description || '—')}</td>` +
        `<td class="r">${escHtml(l.item_code || '—')}</td>` +
        `<td class="r">${fmtNum(l.quantity)}</td>` +
        `<td class="r">${fmtNum(l.received_qty)}</td>` +
        `<td class="r">${fmtNum(pending)}</td>` +
        `<td class="r">${l.rate != null ? fmtNum(l.rate) : '—'}</td>` +
        `<td class="r">${l.uom || '—'}</td>` +
        `<td class="r">${l.discount_percent != null ? fmtNum(l.discount_percent) + '%' : '—'}</td>` +
        `<td class="r">${l.tax_percent != null ? fmtNum(l.tax_percent) + '%' : '—'}</td>` +
        `<td class="r">${l.amount != null ? fmtNum(l.amount) : '—'}</td>` +
        `</tr>`
    }).join('')
    const logoUrl = `${window.location.origin}/Kalika_logo.png`
    return `<!doctype html><html><head><meta charset="utf-8"><title>Purchase Order ${escHtml(d.po_number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin: 28px; background: #fff; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
  .header img { height: 56px; max-width: 180px; object-fit: contain; }
  .header .title { font-size: 22px; font-weight: 700; color: #111; line-height: 1.2; }
  .header .sub-title { font-size: 13px; color: #666; margin-top: 2px; }
  .generated { color: #666; font-size: 11px; margin-bottom: 16px; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 18px; border: 1px solid #ddd; border-radius: 6px; padding: 12px 14px; margin-bottom: 18px; }
  .meta .lbl { display: block; color: #888; font-size: 9px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 2px; }
  .meta .val { font-weight: 600; }
  h2 { font-size: 13px; margin: 16px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 11px; }
  th { background: #f4f4f4; text-transform: uppercase; font-size: 9px; letter-spacing: .4px; color: #555; }
  .r { text-align: right; }
  .total td { font-weight: 700; background: #fafafa; }
  .foot { margin-top: 26px; font-size: 10px; color: #888; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<div class="header">
  <img src="${logoUrl}" alt="Kalika" />
  <div>
    <div class="title">KALIKA ENTERPRISES</div>
    <div class="sub-title">Purchase Order — ${escHtml(d.po_number)}</div>
  </div>
</div>
<div class="generated">Generated ${escHtml(new Date().toLocaleString())}</div>
<div class="meta">
  <div><span class="lbl">Supplier</span><span class="val">${escHtml(d.supplier?.name || d.supplier_name || '—')}</span></div>
  <div><span class="lbl">GST No.</span><span class="val">${escHtml(d.supplier?.gstin || '—')}</span></div>
  <div><span class="lbl">Mobile</span><span class="val">${escHtml(d.supplier?.phone || '—')}</span></div>
  <div><span class="lbl">Email</span><span class="val">${escHtml(d.supplier?.email || '—')}</span></div>
  <div class="meta-full" style="grid-column: 1 / -1;"><span class="lbl">Address</span><span class="val">${escHtml(d.supplier?.address || '—')}</span></div>
  <div><span class="lbl">Order Date</span><span class="val">${escHtml(d.order_date || '—')}</span></div>
  <div><span class="lbl">Status</span><span class="val">${escHtml(d.status || '—')}</span></div>
  <div><span class="lbl">Total Amount</span><span class="val">${fmtNum(d.total_amount)}</span></div>
  <div><span class="lbl">Notes</span><span class="val">${escHtml(d.notes || '—')}</span></div>
</div>
<h2>Purchase Lines</h2>
<table><thead><tr><th>Item</th><th class="r">Item Code</th><th class="r">Qty</th><th class="r">Received</th><th class="r">Pending</th><th class="r">Rate</th><th class="r">UOM</th><th class="r">Disc %</th><th class="r">GST %</th><th class="r">Amount</th></tr></thead>
<tbody>${lineRows || '<tr><td colspan="10">No lines</td></tr>'}</tbody>
<tfoot><tr class="total"><td colspan="9">Order Total</td><td class="r">${fmtNum(d.total_amount)}</td></tr></tfoot></table>
<div class="foot">Generated by Kalika ERP — Purchases</div>
</body></html>`
  }

  const downloadPdf = () => {
    const d = detail
    if (!d || d.loading) return
    const html = buildPoHtml(d)
    const win = window.open('', '_blank', 'width=900,height=760')
    if (!win) { window.alert('Popup blocked — please allow popups to generate the PDF.'); return }
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 350)
  }

  const downloadJpg = async () => {
    const d = detail
    if (!d || d.loading) return
    const html = buildPoHtml(d)
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.left = '-9999px'
    iframe.style.top = '0'
    iframe.style.width = '900px'
    iframe.style.height = '1200px'
    document.body.appendChild(iframe)

    const doc = iframe.contentDocument
    doc.open()
    doc.write(html)
    doc.close()

    await new Promise((resolve) => {
      const img = doc.querySelector('.header img')
      if (!img || img.complete) return resolve()
      img.onload = resolve
      img.onerror = resolve
      setTimeout(resolve, 1000)
    })

    try {
      const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false })
      const link = document.createElement('a')
      link.href = canvas.toDataURL('image/jpeg', 0.95)
      link.download = `purchase_order_${d.po_number}.jpg`
      link.click()
    } catch (err) {
      window.alert('Failed to generate JPG: ' + (err?.message || 'Unknown error'))
    } finally {
      document.body.removeChild(iframe)
    }
  }

  const shareOrder = async () => {
    const d = detail
    if (!d || d.loading) return
    const text = `Purchase Order ${d.po_number} — ${d.supplier?.name || d.supplier_name || 'Supplier'} — Total ${fmtNum(d.total_amount)}`
    if (navigator.share) {
      try { await navigator.share({ title: `PO ${d.po_number}`, text }) } catch { /* user cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(text); window.alert('PO details copied to clipboard') } catch { window.alert('Sharing not supported') }
    }
  }

  const columns = [
    { key: 'po_number', label: 'PO No', render: (r) => <span className="font-mono text-xs font-medium">{r.po_number}</span> },
    { key: 'supplier', label: 'Supplier', render: (r) => <span className="font-medium">{r.supplier?.name || '—'}</span> },
    { key: 'order_date', label: 'Order Date' },
    { key: 'status', label: 'Status', render: (r) => <Badge className={statusCls[r.status]}>{r.status}</Badge> },
    { key: 'total_amount', label: 'Total Amount', render: (r) => <span className="font-mono text-xs font-medium">{fmtNum(r.total_amount)}</span> },
    { key: 'lines', label: 'Lines', render: (r) => <Badge className="bg-slate-100 text-slate-600">{r.lines?.length || 0}</Badge> },
  ]

  const received = items.filter((i) => i.status === 'Received').length
  const partial = items.filter((i) => i.status === 'Partially Received').length
  const partialOpen = items.filter((i) => ['Ordered', 'Partially Received'].includes(i.status))
  const openAmt = partialOpen.reduce((s, i) => s + (Number(i.total_amount) || 0), 0)

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Purchases" subtitle="Supplier purchase orders • Requirement → PO → Ordered → Partially Received → Received → Stock"
        actions={
          <>
            <button onClick={() => downloadFile('/reports/purchases/csv', 'purchases.csv')} className="btn btn-secondary"><Download size={15} /> CSV</button>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
            <button onClick={() => { setShowImport(true); setImportResult(null); setImportFile(null) }} className="btn btn-secondary text-sm">Import</button>
            <button onClick={openNew} className="btn btn-primary"><Plus size={15} /> New PO</button>
          </>
        } />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Purchase Orders" value={items.length} icon={FilePlus2} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Received" value={received} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Partially Received" value={partial} icon={Layers} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
        <StatCard label="Open Value" value={fmtNum(openAmt)} icon={DollarSign} iconClass="bg-blue-50 text-blue-600" />
      </div>

      <Card actions={
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search PO…" className="input input-icon sm:w-56" />
        </div>
      }>
        {loading ? <Loading /> : items.length === 0 ? <Empty /> : <Table columns={columns} data={items} keyField="id" onRowClick={openDetail} stickyColumns={['po_number']} />}
      </Card>

      {detail && (
        <Modal open title={detail && !detail.loading ? `PO ${detail.po_number}` : 'Loading…'} onClose={() => setDetail(null)} xwide
          footer={detail && !detail.loading ? (
            <>
              <div className="flex items-center gap-2 mr-auto">
                <button onClick={() => openEdit(detail)} className="btn btn-secondary"><Pencil size={14} className="mr-1" /> Edit</button>
                <button onClick={() => del(detail)} className="btn btn-danger"><Trash2 size={14} className="mr-1" /> Delete</button>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={shareOrder} className="btn btn-secondary"><Share2 size={14} className="mr-1" /> Share</button>
                <button onClick={downloadPdf} className="btn btn-secondary"><Printer size={14} className="mr-1" /> PDF</button>
                <button onClick={downloadJpg} className="btn btn-secondary"><Image size={14} className="mr-1" /> JPG</button>
                <button onClick={() => setDetail(null)} className="btn btn-secondary">Close</button>
              </div>
            </>
          ) : <button onClick={() => setDetail(null)} className="btn btn-secondary">Close</button>}>
          {detailLoading || detail?.loading ? <Loading /> : (
            <div className="max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
                <div><span className="text-slate-500 block text-xs">PO Number</span><span className="font-medium">{detail.po_number}</span></div>
                <div><span className="text-slate-500 block text-xs">Supplier</span><span className="font-medium">{detail.supplier?.name || detail.supplier_name || '—'}</span></div>
                <div><span className="text-slate-500 block text-xs">GST No.</span><span className="font-medium">{detail.supplier?.gstin || '—'}</span></div>
                <div><span className="text-slate-500 block text-xs">Mobile</span><span className="font-medium">{detail.supplier?.phone || '—'}</span></div>
                <div><span className="text-slate-500 block text-xs">Email</span><span className="font-medium">{detail.supplier?.email || '—'}</span></div>
                <div><span className="text-slate-500 block text-xs">Order Date</span><span className="font-medium">{detail.order_date}</span></div>
                <div><span className="text-slate-500 block text-xs">Status</span><Badge className={statusCls[detail.status]}>{detail.status}</Badge></div>
                <div><span className="text-slate-500 block text-xs">Total Amount</span><span className="font-medium">{fmtNum(detail.total_amount)}</span></div>
                <div className="col-span-2 md:col-span-4"><span className="text-slate-500 block text-xs">Address</span><span className="font-medium">{detail.supplier?.address || '—'}</span></div>
                {detail.notes && <div className="col-span-2 md:col-span-4"><span className="text-slate-500 block text-xs">Notes</span><span className="font-medium">{detail.notes}</span></div>}
                {detail.warnings?.length > 0 && (
                  <div className="col-span-2 md:col-span-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">
                    <strong>Stock not updated:</strong> {detail.warnings.join(' ')}
                  </div>
                )}
              </div>
              <Table
                columns={[
                  { key: 'product', label: 'Product', render: (l) => <span className="font-medium">{l.product?.model || l.description}</span> },
                  { key: 'item_code', label: 'Item Code', render: (l) => <span className="font-mono text-xs">{l.item_code || '—'}</span> },
                  { key: 'quantity', label: 'Qty', render: (l) => fmtNum(l.quantity) },
                  { key: 'received_qty', label: 'Received', render: (l) => fmtNum(l.received_qty) },
                  { key: 'pending', label: 'Pending', render: (l) => <span className={l.quantity - (l.received_qty || 0) > 0 ? 'text-amber-600' : 'text-green-600'}>{fmtNum((l.quantity || 0) - (l.received_qty || 0))}</span> },
                  { key: 'rate', label: 'Rate', render: (l) => l.rate != null ? fmtNum(l.rate) : '—' },
                  { key: 'uom', label: 'UOM', render: (l) => l.uom || '—' },
                  { key: 'tax_percent', label: 'GST %', render: (l) => l.tax_percent != null ? `${l.tax_percent}%` : '—' },
                  { key: 'discount_percent', label: 'Disc %', render: (l) => l.discount_percent != null ? `${l.discount_percent}%` : '—' },
                  { key: 'amount', label: 'Total Amount', render: (l) => l.amount != null ? fmtNum(l.amount) : '—' },
                ]}
                data={detail.lines || []}
                dense
              />

              {/* Inline receive section for pending lines */}
              {(() => {
                const pendingLines = (detail.lines || []).filter((l) => (Number(l.quantity || 0) - Number(l.received_qty || 0)) > 0)
                if (pendingLines.length === 0) return null
                return (
                  <div className="mt-6 pt-4 border-t border-slate-200">
                    <h4 className="text-sm font-semibold mb-3 flex items-center gap-2"><PackageOpen size={16} /> Receive Items</h4>
                    {receiveErr && <div className="mb-3 text-sm bg-red-50 text-red-700 border border-red-200 rounded px-3 py-2">{receiveErr}</div>}
                    {receiveMsg && <div className="mb-3 text-sm bg-green-50 text-green-700 border border-green-200 rounded px-3 py-2">{receiveMsg}</div>}
                    <div className="space-y-4">
                      {pendingLines.map((line) => {
                        const already = Number(line.received_qty || 0)
                        const ordered = Number(line.quantity || 0)
                        const remaining = ordered - already
                        return (
                          <div key={line.id} className="border border-slate-200 rounded-xl bg-slate-50/60 p-4">
                            <div className="flex items-start justify-between gap-3 mb-3">
                              <div className="min-w-0">
                                <div className="font-semibold text-slate-800 truncate">{line.description || line.product?.model || line.item_code || 'Line item'}</div>
                                <div className="text-xs text-slate-500 mt-0.5">
                                  {line.item_code && <span className="font-mono">{line.item_code}</span>}
                                  {line.item_code && line.uom && <span className="mx-1.5 text-slate-300">|</span>}
                                  {line.uom && <span>{line.uom}</span>}
                                </div>
                              </div>
                              <Badge className="bg-amber-100 text-amber-700">Pending</Badge>
                            </div>
                            <div className="grid grid-cols-3 gap-3 mb-4">
                              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Ordered</div>
                                <div className="text-lg font-bold text-slate-800">{fmtNum(ordered)}</div>
                              </div>
                              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Already Received</div>
                                <div className="text-lg font-bold text-green-700">{fmtNum(already)}</div>
                              </div>
                              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Remaining</div>
                                <div className="text-lg font-bold text-amber-700">{fmtNum(remaining)}</div>
                              </div>
                            </div>
                            <div className="flex items-end gap-3">
                              <div className="flex-1">
                                <label className="block text-xs font-medium text-slate-500 mb-1">Receive Quantity (this receipt)</label>
                                <input type="number" className="input w-full text-xl font-bold py-3" min="0" max={remaining} step="0.01"
                                  value={receiveQty[line.id] || ''} placeholder={`0 — ${remaining} remaining`}
                                  onChange={(e) => setReceiveQty((q) => ({ ...q, [line.id]: e.target.value }))} />
                              </div>
                              <button onClick={() => receiveLine(line)} className="btn btn-primary px-6 py-2.5 text-sm" disabled={receiveBusy}>
                                {receiveBusy ? 'Saving…' : 'Receive'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
        </Modal>
      )}

      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal-panel p-5 max-w-lg" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">Import Purchase Orders</h3>
            <p className="text-sm text-gray-500 mb-4">
              CSV or Excel. Required: PO Number, Item Code or Description, Quantity.
              Optional: Supplier, Rate, UOM, GST %, Discount %.
            </p>
            <input type="file" accept=".csv,.xlsx,.xls" className="input mb-4" onChange={e => setImportFile(e.target.files?.[0])} />
            {importResult && (
              <div className="bg-gray-50 rounded-lg p-4 mb-4 text-sm">
                <p className="font-bold mb-1">Results</p>
                <p>Created: {importResult.summary.created}, Skipped: {importResult.summary.skipped}, Errors: {importResult.summary.errors}</p>
                {importResult.skipped.length > 0 && (
                  <ul className="mt-2 text-amber-700 text-xs">
                    {importResult.skipped.map((s, i) => <li key={i}>Row {s.rows?.[0]}: {s.po_number} — {s.reason}</li>)}
                  </ul>
                )}
                {importResult.errors.length > 0 && (
                  <ul className="mt-2 text-red-600 text-xs max-h-40 overflow-auto">
                    {importResult.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                  </ul>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={async () => {
                if (!importFile) return
                const fd = new FormData(); fd.append('file', importFile)
                setImportBusy(true)
                try {
                  const { data } = await api.post('/purchases/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
                  setImportResult(data); load()
                } catch (e) { alert(e.response?.data?.detail || 'Import failed') }
                finally { setImportBusy(false) }
              }} className="btn btn-primary" disabled={importBusy}>
                {importBusy ? 'Importing…' : 'Import'}
              </button>
              <button onClick={() => { setShowImport(false); setImportResult(null); setImportFile(null) }} className="btn btn-secondary">Close</button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <Modal open title={form.id ? `Edit PO ${form.po_number}` : 'New Purchase Order'} onClose={() => setShowForm(false)} xwide
          footer={<>
            <button onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} className="btn btn-primary">{form.id ? 'Save Changes' : 'Create PO'}</button>
          </>}>
          {error && <div className="mb-3 text-sm state-box bg-red-50 text-red-700 border border-red-200">{error}</div>}
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div><label className="block text-slate-500 text-xs mb-1">PO Number *</label>
              <input value={form.po_number || ''} onChange={(e) => setForm({ ...form, po_number: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Order Date</label>
              <input type="date" value={form.order_date || ''} onChange={(e) => setForm({ ...form, order_date: e.target.value })} className="input" /></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Supplier</label>
              <SearchSelect
                options={suppliers.map((s) => ({ id: s.id, label: s.company || s.name }))}
                value={form.supplier_id || null}
                initialLabel={!form.supplier_id ? (form.supplier_name || '') : ''}
                placeholder="Type to search suppliers or enter a new supplier name"
                onChange={(id, manual) => setSupplier(id, manual)}
              />
              {!form.supplier_id && form.supplier_name && (
                <span className="text-xs text-amber-600 mt-1 block">New supplier will be created when PO is saved.</span>
              )}
              {form.supplier_id && (
                <span className="text-xs text-green-600 mt-1 block">Existing supplier selected from Supplier Master.</span>
              )}
            </div>
            <div><label className="block text-slate-500 text-xs mb-1">Supplier Name *</label>
              <input value={form.supplier_name || ''} onChange={(e) => setForm({ ...form, supplier_name: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">GST No.</label>
              <input value={form.supplier_gstin || ''} onChange={(e) => setForm({ ...form, supplier_gstin: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Mobile</label>
              <input value={form.supplier_phone || ''} onChange={(e) => setForm({ ...form, supplier_phone: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Email</label>
              <input value={form.supplier_email || ''} onChange={(e) => setForm({ ...form, supplier_email: e.target.value })} className="input" /></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Address</label>
              <input value={form.supplier_address || ''} onChange={(e) => setForm({ ...form, supplier_address: e.target.value })} className="input" /></div>
            <div><label className="block text-slate-500 text-xs mb-1">Status</label>
              <select value={form.status || 'Ordered'} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></div>
            <div className="col-span-2"><label className="block text-slate-500 text-xs mb-1">Notes</label>
              <input value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input" /></div>
          </div>

          <div className="mb-1 text-xs font-medium text-slate-500 uppercase">Purchase Lines</div>
          <div className="hidden sm:grid grid-cols-12 gap-2 items-center text-[10px] uppercase tracking-wide text-slate-400 mb-1 px-1">
            <div className="col-span-3">Product / Manual Item</div>
            <div className="col-span-1">Item Code</div>
            <div className="col-span-1">Qty</div>
            <div className="col-span-1">Rate</div>
            <div className="col-span-1">UOM</div>
            <div className="col-span-2">GST %</div>
            <div className="col-span-2">Disc %</div>
            <div className="col-span-1" />
          </div>
          <div className="space-y-3">
            {form.lines.map((ln, i) => {
              const c = calcLine(ln)
              return (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-12 gap-2 items-center text-xs">
                    <SearchSelect
                      options={products.map((p) => ({ id: p.id, label: `${p.model}${p.item_code ? ` (${p.item_code})` : ''}` }))}
                      value={ln.product_id || null}
                      initialLabel={!ln.product_id ? (ln.description || '') : ''}
                      placeholder="Product or manual item…"
                      className="input col-span-3 py-2"
                      onChange={(id, manual) => setLineProduct(i, id || '', manual)}
                    />
                    <input value={ln.item_code ?? ''} onChange={(e) => setLine(i, 'item_code', e.target.value)}
                      placeholder="Code" className="input col-span-1 py-2" />
                    <input value={ln.quantity ?? ''} type="number" onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="Qty" className="input col-span-1 py-2" />
                    <input value={ln.rate ?? ''} type="number" onChange={(e) => setLine(i, 'rate', e.target.value)} placeholder="Rate" className="input col-span-1 py-2" />
                    <input value={ln.uom || ''} onChange={(e) => setLine(i, 'uom', e.target.value)} placeholder="UOM" className="input col-span-1 py-2" />
                    <input value={ln.tax_percent ?? ''} list="gst-suggestions" type="number" min="0" step="0.01" onChange={(e) => setLine(i, 'tax_percent', e.target.value === '' ? null : Number(e.target.value))} placeholder="GST %" className="input col-span-2 py-2 text-sm font-semibold text-right" />
                    <input value={ln.discount_percent ?? ''} type="number" min="0" step="0.01" onChange={(e) => setLine(i, 'discount_percent', e.target.value === '' ? null : Number(e.target.value))} placeholder="Disc %" className="input col-span-2 py-2 text-sm font-semibold text-right" />
                    <button onClick={() => { if (form.lines.length > 1) setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) }) }} className="col-span-1 text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-slate-500 px-1">
                    <span>Basic: <b className="text-slate-700">{fmtNum(c.basic)}</b></span>
                    <span>Disc: <b className="text-slate-700">{fmtNum(c.discount)}</b></span>
                    <span>Taxable: <b className="text-slate-700">{fmtNum(c.taxable)}</b></span>
                    <span>GST: <b className="text-slate-700">{fmtNum(c.gst)}</b></span>
                    <span>Total: <b className="text-blue-700">{fmtNum(c.total)}</b></span>
                  </div>
                </div>
              )
            })}
            <datalist id="gst-suggestions">
              <option value="5" />
              <option value="12" />
              <option value="18" />
            </datalist>
          </div>
          <button onClick={() => setForm({ ...form, lines: [...form.lines, { product_id: '', description: '', item_code: '', quantity: '', received_qty: 0, rate: '', amount: '', uom: '', tax_percent: null, discount_percent: null }] })} className="btn btn-ghost mt-2 text-xs"><Plus size={12} className="inline mr-1" />Add line</button>
          <div className="mt-4 flex justify-end border-t pt-3">
            <div className="text-right">
              <div className="text-xs text-slate-500 uppercase tracking-wide">Grand Total</div>
              <div className="text-2xl font-bold text-slate-800">{fmtNum(form.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0))}</div>
            </div>
          </div>
        </Modal>
      )}
    </div>
)
}
