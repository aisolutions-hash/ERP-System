import { useEffect, useState } from 'react'
import { Download, RefreshCw, Users, Truck, Package, Factory, Boxes, ClipboardList, Scale } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Loading, Empty, Badge, StatCard, PageTabs } from '../components/ui'
import { fmtNum } from '../lib/format'

const TABS = [
  { key: 'customer', label: 'Customer Summary', icon: <Users size={15} /> },
  { key: 'dispatch', label: 'Dispatch Summary', icon: <Truck size={15} /> },
  { key: 'delivery', label: 'Delivery Report', icon: <Package size={15} /> },
  { key: 'production', label: 'Production', icon: <Factory size={15} /> },
  { key: 'raw', label: 'Raw Material', icon: <Boxes size={15} /> },
  { key: 'pending', label: 'Pending / Over-fulfilled', icon: <ClipboardList size={15} /> },
  { key: 'trading', label: 'Trading vs Manufacturing', icon: <Scale size={15} /> },
]

export default function Reports() {
  const [tab, setTab] = useState('customer')
  const [fulfilment, setFulfilment] = useState([])
  const [dispatchSum, setDispatchSum] = useState([])
  const [production, setProduction] = useState([])
  const [raw, setRaw] = useState([])
  const [delivery, setDelivery] = useState({ items: [], summary: [], totals: { by_status: {} } })
  const [loading, setLoading] = useState(true)
  const [dStatus, setDStatus] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [f, ds, prod, rm, del] = await Promise.all([
        api.get('/fulfilment'),
        api.get('/dispatch/summary'),
        api.get('/production'),
        api.get('/raw-materials', { params: { page_size: 500 } }),
        api.get('/reports/delivery'),
      ])
      setFulfilment(f.data.items || [])
      setDispatchSum(ds.data.items || [])
      setProduction(prod.data.items || [])
      setRaw(rm.data.items || [])
      setDelivery(del.data || { items: [], summary: [], totals: { by_status: {} } })
    } catch {} finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // customer summary: group fulfilment by customer
  const customerSum = []
  const byCust = {}
  for (const it of fulfilment) {
    const key = it.customer || 'Unknown'
    if (!byCust[key]) byCust[key] = { customer: key, orders: 0, ordered: 0, fulfilled: 0, balance: 0, over: 0 }
    byCust[key].orders++
    byCust[key].ordered += it.ordered_qty
    byCust[key].fulfilled += it.fulfilled_qty
    byCust[key].balance += it.balance
    if (it.balance < 0) byCust[key].over++
  }
  for (const c of Object.values(byCust)) {
    c.ordered = Math.round(c.ordered); c.fulfilled = Math.round(c.fulfilled)
    c.balance = Math.round(c.balance); c.completion = c.ordered > 0 ? Math.max(0, Math.min(100, (c.fulfilled / c.ordered) * 100)) : 0
    customerSum.push(c)
  }
  customerSum.sort((a, b) => b.ordered - a.ordered)

  const pending = fulfilment.filter((x) => x.balance > 0)
  const overFulfilled = fulfilment.filter((x) => x.balance < 0)

  const tradingCount = fulfilment.filter((x) => x.source_type === 'TRADING').length
  const manufacturingCount = fulfilment.filter((x) => x.source_type === 'MANUFACTURED').length

  const renderTab = () => {
    if (tab === 'customer') return (
      <Card title="Customer Summary" subtitle="Orders, ordered qty, dispatch qty, balance, completion">
        {loading ? <Loading /> : <Table title="Customer" data={customerSum} cols={[
          ['customer', 'Customer'], ['orders', 'Orders', 'num'], ['ordered', 'Ordered Qty', 'num'],
          ['fulfilled', 'Dispatch Qty', 'num'], ['balance', 'Balance', 'num'],
          ['over', 'Over-fulfilled', 'num'], ['completion', 'Completion %', 'pct'],
        ]} />}
      </Card>
    )
    if (tab === 'dispatch') return (
      <Card title="Dispatch Summary" subtitle="By dispatches">
        {loading ? <Loading /> : <Table title="Dispatch" data={dispatchSum} cols={[
          ['customer', 'Customer'], ['total_schedule', 'Scheduled', 'num'],
          ['total_dispatched', 'Dispatched', 'num'], ['total_balance', 'Balance', 'num'],
          ['count', 'Dispatches', 'num'], ['over_dispatched', 'Over-dispatched', 'flag'],
        ]} />}
      </Card>
    )
    if (tab === 'delivery') {
      const byStatus = delivery.totals.by_status || {}
      const statusKeys = Object.keys(byStatus)
      const filtered = dStatus ? delivery.items.filter((i) => i.delivery_status === dStatus) : delivery.items
      return (
        <div className="space-y-4">
          <Card title="Delivery Report" subtitle="Complete / Partial / Not dispatched per order"
            actions={
              <div className="flex items-center gap-2 flex-wrap">
                <select value={dStatus} onChange={(e) => setDStatus(e.target.value)} className="input">
                  <option value="">All statuses</option>
                  {statusKeys.map((k) => <option key={k} value={k}>{k} ({byStatus[k]})</option>)}
                </select>
                <a href="/api/reports/delivery/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
              </div>
            }>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <StatCard label="Ordered" value={fmtNum(delivery.totals.ordered)} icon={Package} iconClass="bg-slate-50 text-slate-700" />
              <StatCard label="Dispatched" value={fmtNum(delivery.totals.dispatched)} icon={Truck} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
              <StatCard label="Balance" value={fmtNum(delivery.totals.balance)} icon={Scale} iconClass="bg-amber-50 text-amber-600" valueClass="text-amber-600" />
              <StatCard label="Lines" value={delivery.total} icon={ClipboardList} iconClass="bg-purple-50 text-purple-600" />
            </div>
            {loading ? <Loading /> : <Table title="Delivery" data={filtered.slice(0, 200)} cols={[
              ['order_no', 'Order', 'mono'], ['customer', 'Customer'], ['customer_po_no', 'PO No'],
              ['model', 'Product', 'sub'], ['ordered_qty', 'Ordered', 'num'],
              ['dispatched_qty', 'Dispatch', 'num'], ['balance_qty', 'Balance', 'neg'],
              ['delivery_status', 'Delivery', 'delivery'],
            ]} />}
          </Card>
          <Card title="Delivery by Customer" subtitle="Rollup of completion">
            <Table title="DeliveryCust" data={delivery.summary} cols={[
              ['customer', 'Customer'], ['order_count', 'Orders', 'num'], ['ordered', 'Ordered', 'num'],
              ['dispatched', 'Dispatched', 'num'], ['balance', 'Balance', 'neg'],
              ['delivery_pct', 'Delivery %', 'pct'], ['completed', 'Complete', 'num'],
              ['partial', 'Partial', 'num'], ['not_dispatched', 'Not Dispatch', 'num'],
            ]} />
          </Card>
        </div>
      )
    }
    if (tab === 'production') return (
      <Card title="Production Summary" subtitle="Plan vs produced remaining">
        {loading ? <Loading /> : <Table title="Production" data={production} cols={[
          ['order_no', 'Order No'], ['product', 'Product', 'sub'], ['schedule_qty', 'Planned', 'num'],
          ['produced_qty', 'Produced', 'num'], ['balance_qty', 'Pending', 'num'], ['completion_pct', 'Completion %', 'pct'],
          ['status', 'Status', 'badge'],
        ]} />}
      </Card>
    )
    if (tab === 'raw') return (
      <Card title="Raw Material Summary" subtitle="Required vs available computed from BOM engine">
        {loading ? <Loading /> : <RawShortageView />}
        <div className="text-xs text-slate-400 mt-3">Opening stock is stored in balances; consumption data not available for historical periods.</div>
      </Card>
    )
    if (tab === 'pending') return (
      <div className="space-y-4">
        <Card title={`Pending (${pending.length})`} subtitle="Balance > 0">
          <Table title="Pending" data={pending.slice(0, 100)} cols={[
            ['customer', 'Customer'], ['order_no', 'Order', 'mono'], ['product_name', 'Product'],
            ['ordered_qty', 'Ordered', 'num'], ['fulfilled_qty', 'Dispatch', 'num'], ['balance', 'Balance', 'num'],
            ['customer_po_no', 'PO'], ['fulfilment_status', 'Status', 'badge2'],
          ]} />
        </Card>
        <Card title={`Over-fulfilled (${overFulfilled.length})`} subtitle="Balance < 0 — allowed, shown as over-fulfilled">
          <Table title="Over" data={overFulfilled} cols={[
            ['customer', 'Customer'], ['order_no', 'Order', 'mono'], ['product_name', 'Product'],
            ['ordered_qty', 'Ordered', 'num'], ['fulfilled_qty', 'Dispatch', 'num'],
            ['balance', 'Balance', 'neg'], ['customer_po_no', 'PO'],
          ]} />
        </Card>
      </div>
    )
    return (
      <Card title="Trading vs Manufacturing" subtitle="Mix of sourced lines in open orders">
        {loading ? <Loading /> : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <StatCard label="Trading lines" value={tradingCount} icon={Scale} iconClass="bg-amber-50 text-amber-600" />
            <StatCard label="Manufactured lines" value={manufacturingCount} icon={Factory} iconClass="bg-blue-50 text-blue-600" />
            <StatCard label="Mixed / Unknown" value={fulfilment.length - tradingCount - manufacturingCount} icon={Package} iconClass="bg-purple-50 text-purple-600" />
          </div>
        )}
        <TheBreakdown data={fulfilment} />
      </Card>
    )
  }

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Reports" subtitle="Business-readable summaries"
        actions={
          <>
            <a href="/api/reports/excel" className="btn btn-secondary"><Download size={15} /> Full Excel</a>
            <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
          </>
        } />
      <PageTabs tabs={TABS} active={tab} onChange={setTab} />
      {renderTab()}
    </div>
  )
}

function RawShortageView() {
  const [agg, setAgg] = useState([])
  useEffect(() => {
    api.get('/material-requirements/rm-shortage').then((r) => setAgg(r.data || [])).catch(() => {})
  }, [])
  if (agg.length === 0) return <div className="text-sm text-slate-400 py-4">No raw material shortages from BOM engine. Configure BOMs to compute requirements.</div>
  return (
    <Table title="RM" data={agg} cols={[
      ['raw_material_name', 'Raw Material'], ['required_quantity', 'Required', 'num'],
      ['available_quantity', 'Available', 'num'], ['shortage_quantity', 'Shortage', 'neg'],
      ['uom', 'UOM'], ['products', 'Products', 'list'], ['status', 'Status', 'badge'],
    ]} />
  )
}

function TheBreakdown({ data }) {
  const src = {}
  for (const it of data) {
    if (!src[it.source_type]) src[it.source_type] = { source: it.source_type, lines: 0, ordered: 0, balance: 0 }
    src[it.source_type].lines++
    src[it.source_type].ordered += it.ordered_qty
    src[it.source_type].balance += it.balance
  }
  return (
    <Table title="BySource" data={Object.values(src)} cols={[
      ['source', 'Source Type'], ['lines', 'Lines', 'num'], ['ordered', 'Ordered Qty', 'num'], ['balance', 'Balance', 'num'],
    ]} />
  )
}

function Table({ title, data, cols }) {
  if (!data || data.length === 0) return <Empty text={`No ${title} data`} />
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr>
          {cols.map(([key, label], ci) => <th key={key} className={ci === 0 ? 'col-sticky' : ''}>{label}</th>)}
        </tr></thead>
        <tbody>
          {data.map((r, i) => (
            <tr key={i}>
              {cols.map(([key, label, kind], ci) => {
                let v = r[key]
                if (kind === 'num') v = <span className="font-medium">{fmtNum(v)}</span>
                if (kind === 'neg') v = <span className={`font-semibold ${Number(v) < 0 ? 'text-red-600' : ''}`}>{fmtNum(v)}</span>
                if (kind === 'pct') v = <span>{v != null ? `${(Number(v) * 100).toFixed(1)}%` : '—'}</span>
                if (kind === 'flag') v = v ? <Badge className="bg-red-100 text-red-700">Yes</Badge> : <Badge className="bg-gray-100 text-gray-500">No</Badge>
                if (kind === 'badge') v = <Badge className="bg-slate-100 text-slate-600">{v || '—'}</Badge>
                if (kind === 'badge2') {
                  const map = { READY_FOR_DISPATCH: 'bg-green-100 text-green-700', PRODUCTION_REQUIRED: 'bg-blue-100 text-blue-700', PURCHASE_REQUIRED: 'bg-amber-100 text-amber-700', MANUAL_DECISION_REQUIRED: 'bg-purple-100 text-purple-700', FULFILLED: 'bg-slate-100 text-slate-600', OVER_FULFILLED: 'bg-red-100 text-red-700' }
                  v = <Badge className={map[v] || 'bg-gray-100 text-gray-600'}>{v || '—'}</Badge>
                }
                if (kind === 'delivery') {
                  const map = { Completed: 'bg-green-100 text-green-700', 'Partially Dispatched': 'bg-amber-100 text-amber-700', 'Not Dispatched': 'bg-red-100 text-red-700' }
                  v = <Badge className={map[v] || 'bg-gray-100 text-gray-600'}>{v || '—'}</Badge>
                }
                if (kind === 'sub') v = <span className="text-slate-500 text-xs">{v?.model || (typeof v === 'string' ? v.slice(0, 40) : '—')}</span>
                if (kind === 'mono') v = <span className="font-mono text-xs">{v || '—'}</span>
                if (kind === 'list') v = <span className="text-xs text-slate-500">{Array.isArray(v) ? v.join(', ').slice(0, 60) : v || '—'}</span>
                return <td key={key} className={ci === 0 ? 'col-sticky' : ''}>{v ?? '—'}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}