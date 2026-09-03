import { useEffect, useState } from 'react'
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, MinusCircle, ClipboardList, Layers, PackageCheck, PackageX } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard, PageTabs } from '../components/ui'
import { fmtNum } from '../lib/format'

const TABS = [
  { key: 'requirements', label: 'Material Requirements', icon: <ClipboardList size={15} /> },
  { key: 'shortage', label: 'RM Shortage', icon: <PackageX size={15} /> },
  { key: 'readiness', label: 'Production Readiness', icon: <PackageCheck size={15} /> },
]

function StatusBadge({ status }) {
  if (status === 'READY') return <Badge className="bg-green-100 text-green-700"><CheckCircle2 size={13} className="inline mr-1" />Ready</Badge>
  if (status === 'SHORTAGE') return <Badge className="bg-amber-100 text-amber-700"><AlertTriangle size={13} className="inline mr-1" />Shortage</Badge>
  if (status === 'NO_BOM') return <Badge className="bg-red-100 text-red-700"><XCircle size={13} className="inline mr-1" />No BOM</Badge>
  return <Badge>{status}</Badge>
}

export default function MaterialRequirements() {
  const [tab, setTab] = useState('requirements')
  const [data, setData] = useState({ requirements: [], rm_aggregate: [] })
  const [shortages, setShortages] = useState([])
  const [readiness, setReadiness] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [sum, short, ready] = await Promise.all([
        api.get('/material-requirements/summary'),
        api.get('/material-requirements/rm-shortage'),
        api.get('/material-requirements/production-readiness'),
      ])
      setData(sum.data || { requirements: [], rm_aggregate: [] })
      setShortages(short.data || [])
      setReadiness(ready.data || [])
    } catch { } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const hasBomCount = readiness.filter((r) => r.has_bom).length
  const readyCount = readiness.filter((r) => r.status === 'READY').length
  const shortageCount = readiness.filter((r) => r.status === 'SHORTAGE').length
  const noBomCount = readiness.filter((r) => r.status === 'NO_BOM').length

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Material Requirements" subtitle="Production requirement → BOM → raw material requirement"
        actions={<button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>} />

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'requirements' && (
        <Card title="Production Requirements & Material Needs">
          {loading ? <Loading /> : data.requirements.length === 0 ? <Empty /> :
            (
              <div className="space-y-3">
                {data.requirements.map((r, i) => (
                  <div key={i} className="card p-4">
                    <div className="flex items-center justify-between text-sm">
                      <div>
                        <span className="font-medium">{r.product_name}</span>
                        {r.customer && <span className="text-slate-500"> · {r.customer}</span>}
                        <span className="text-slate-500"> · Prod qty {fmtNum(r.production_quantity)}</span>
                        {r.date && <span className="text-slate-400"> · {r.date}</span>}
                      </div>
                      <StatusBadge status={r.status} />
                    </div>
                    {r.has_bom ? (
                      <div className="mt-3 table-wrap">
                        <table className="data-table">
                          <thead><tr>
                            <th>Raw Material</th><th>Qty/Unit</th>
                            <th>UOM</th><th>Required</th>
                            <th>Available</th><th>Shortage</th><th>Status</th>
                          </tr></thead>
                          <tbody>
                            {r.items.map((it, j) => (
                              <tr key={j}>
                                <td className="!sticky left-0 bg-inherit font-medium">{it.raw_material_name}</td>
                                <td>{fmtNum(it.bom_quantity_per_unit)}</td>
                                <td>{it.uom}</td>
                                <td className="font-medium">{fmtNum(it.required_quantity)}</td>
                                <td>{fmtNum(it.available_quantity)}</td>
                                <td className={`font-semibold ${it.shortage_quantity > 0 ? 'text-red-600' : 'text-green-600'}`}>{fmtNum(it.shortage_quantity)}</td>
                                <td><StatusBadge status={it.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-red-500">No BOM configured for this product — raw material requirement cannot be calculated.</div>
                    )}
                  </div>
                ))}
              </div>
            )}
        </Card>
      )}

      {tab === 'shortage' && (
        <Card title="Raw Material Shortage" subtitle="RM where required > available">
          {loading ? <Loading /> : shortages.length === 0 ? <Empty text="No raw material shortages" /> :
            <div className="table-wrap"><table className="data-table">
              <thead><tr>
                <th>Raw Material</th><th>Required</th>
                <th>Available</th><th>Shortage</th>
                <th>UOM</th><th>Products</th><th>Status</th>
              </tr></thead>
              <tbody>
                {shortages.map((s) => (
                  <tr key={s.raw_material_id}>
                    <td className="!sticky left-0 bg-inherit font-medium">{s.raw_material_name}</td>
                    <td>{fmtNum(s.required_quantity)}</td>
                    <td>{fmtNum(s.available_quantity)}</td>
                    <td className="font-semibold text-red-600">{fmtNum(s.shortage_quantity)}</td>
                    <td>{s.uom}</td>
                    <td className="text-xs text-slate-500">{s.products.join(', ')}</td>
                    <td><StatusBadge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>}
        </Card>
      )}

      {tab === 'readiness' && (
        <div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <StatCard label="Ready" value={readyCount} icon={CheckCircle2} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
            <StatCard label="Shortage" value={shortageCount} icon={AlertTriangle} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
            <StatCard label="No BOM" value={noBomCount} icon={XCircle} iconClass="bg-red-50 text-red-600" valueClass="text-red-600" />
            <StatCard label="Products" value={readiness.length} icon={Layers} iconClass="bg-slate-100 text-slate-600" />
          </div>
          <Card title="Production Material Readiness" subtitle="Whether materials support production for each product (warning only, does not auto-block)">
            {loading ? <Loading /> : readiness.length === 0 ? <Empty /> :
              <div className="table-wrap"><table className="data-table">
                <thead><tr>
                  <th>Product</th><th>Family</th><th>BOM</th><th>Material Status</th>
                </tr></thead>
                <tbody>
                  {readiness.map((r) => (
                    <tr key={r.product_id}>
                      <td className="!sticky left-0 bg-inherit font-medium">{r.product_name}</td>
                      <td className="text-xs text-slate-500">{r.family || '—'}</td>
                      <td>{r.has_bom ? <CheckCircle2 size={16} className="text-green-500" /> : <MinusCircle size={16} className="text-slate-300" />}</td>
                      <td><StatusBadge status={r.status} /><span className="ml-2 text-xs text-slate-400">{r.label}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
          </Card>
        </div>
      )}
    </div>
  )
}