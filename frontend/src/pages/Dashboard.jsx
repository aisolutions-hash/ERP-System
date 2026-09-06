import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ShoppingBag, Truck, Factory, Boxes, AlertTriangle, TrendingUp, ArrowRight,
  BellRing, PackageX, TimerReset, DollarSign, Users, Award, BarChart3, Activity,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts'
import api from '../lib/api'
import { Card, StatCard, Loading, LoadingSkeleton, Badge } from '../components/ui'
import { fmtNum } from '../lib/format'

const TREND_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4']

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-medium text-slate-700">{typeof p.value === 'number' ? fmtNum(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

function DonutTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-slate-700">{p.name}</div>
      <div className="text-slate-500">count: <span className="font-medium text-slate-700">{fmtNum(p.value)}</span></div>
    </div>
  )
}

export default function Dashboard() {
  const [summary, setSummary] = useState(null)
  const [byPlant, setByPlant] = useState([])
  const [byProduct, setByProduct] = useState([])
  const [pipeline, setPipeline] = useState([])
  const [invStatus, setInvStatus] = useState([])
  const [trends, setTrends] = useState([])
  const [lowStock, setLowStock] = useState([])
  const [alerts, setAlerts] = useState({ unread: 0, total_open: 0, critical_unread: 0 })
  const [rmShortage, setRmShortage] = useState([])
  // Phase 7: sales & marketing analytics
  const [salesByCustomer, setSalesByCustomer] = useState([])
  const [salesBySalesperson, setSalesBySalesperson] = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [orderTypeMix, setOrderTypeMix] = useState([])
  const [revenueTrend, setRevenueTrend] = useState([])
  const [fulfilment, setFulfilment] = useState(null)
  const [scanAnalytics, setScanAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/summary'),
      api.get('/dashboard/dispatch-by-plant'),
      api.get('/dashboard/production-by-product'),
      api.get('/dashboard/order-pipeline'),
      api.get('/dashboard/inventory-status'),
      api.get('/dashboard/daily-trends', { params: { days: 30 } }),
      api.get('/dashboard/low-stock-list'),
      api.get('/alerts/count'),
      api.get('/material-requirements/rm-shortage'),
      // Phase 7: new endpoints
      api.get('/dashboard/sales-by-customer', { params: { days: 90, limit: 8 } }),
      api.get('/dashboard/sales-by-salesperson', { params: { days: 90 } }),
      api.get('/dashboard/top-products', { params: { days: 90, limit: 8 } }),
      api.get('/dashboard/order-type-mix'),
      api.get('/dashboard/revenue-trend', { params: { days: 30 } }),
      api.get('/dashboard/fulfilment-health'),
      api.get('/barcodes/scan-events/analytics', { params: { days: 30 } }),
    ])
      .then(([s, bp, bpr, op, iv, tr, ls, al, rms,
               sbc, sbsp, tp, otm, rv, fh, scana]) => {
        setSummary(s.data)
        setByPlant(bp.data.items || [])
        setByProduct((bpr.data.items || []).slice(0, 10))
        setPipeline(op.data.items || [])
        setInvStatus(iv.data.items || [])
        setTrends((tr.data.items || []).slice(-30))
        setLowStock(ls.data.items || [])
        setAlerts(al.data || { unread: 0, total_open: 0, critical_unread: 0 })
        setRmShortage(Array.isArray(rms.data) ? rms.data : [])
        setSalesByCustomer(sbc.data.items || [])
        setSalesBySalesperson(sbsp.data.items || [])
        setTopProducts(tp.data.items || [])
        setOrderTypeMix(otm.data.items || [])
        setRevenueTrend(rv.data.items || [])
        setFulfilment(fh.data)
        setScanAnalytics(scana.data)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading && !summary) return (
    <div>
      <h2 className="page-title mb-1">Dashboard</h2>
      <p className="page-subtitle mb-6">Loading overview…</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="card p-5"><div className="skeleton h-3 w-24 mb-4" /><div className="skeleton h-8 w-32" /></div>)}
      </div>
      <Card><div className="h-64"><LoadingSkeleton rows={6} /></div></Card>
    </div>
  )
  if (!summary) return <Loading />

  return (
    <div className="animate-fade-in-up">
      <h2 className="page-title mb-1">Dashboard</h2>
      <p className="page-subtitle mb-6">
        Overview for <span className="font-semibold text-slate-700">{summary.report_date}</span>
        {' · '}Period fulfilment: <span className="font-semibold text-emerald-700">{fmtNum(summary.fulfilment_pct)}%</span>
      </p>

      {/* ROW 1: Operational KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4">
        <StatCard label="Total Orders" value={fmtNum(summary.total_orders)} sub={`${fmtNum(summary.completed_orders)} completed`} icon={ShoppingBag} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Pending Orders" value={fmtNum(summary.pending_orders)} sub="not yet completed" icon={TimerReset} iconClass="bg-orange-50 text-orange-600" />
        <StatCard label="Dispatch" value={fmtNum(summary.dispatch_done)} sub={`of ${fmtNum(summary.dispatch_scheduled)} scheduled`} icon={Truck} iconClass="bg-cyan-50 text-cyan-600" />
        <StatCard label="Production Output" value={fmtNum(summary.production_produced_qty)} sub={`${fmtNum(summary.production_pending_qty)} pending`} icon={Factory} iconClass="bg-violet-50 text-violet-600" />
      </div>

      {/* ROW 2: Sales & Marketing KPIs (Phase 7) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-4">
        <StatCard label="Open Pipeline Value" value={`₹${fmtNum(summary.open_pipeline_value)}`} sub="orders in flight" icon={DollarSign} iconClass="bg-emerald-50 text-emerald-600" />
        <StatCard label="Dispatched Revenue" value={`₹${fmtNum(summary.dispatched_revenue)}`} sub="dispatched + completed" icon={TrendingUp} iconClass="bg-emerald-50 text-emerald-600" />
        <StatCard
          label="Fulfilment %"
          value={`${fmtNum(summary.fulfilment_pct)}%`}
          sub="dispatched ÷ total"
          icon={Activity}
          iconClass={summary.fulfilment_pct >= 80 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}
        />
        <StatCard
          label="Scans (30d)"
          value={fmtNum(scanAnalytics?.total_scans || 0)}
          sub={`${scanAnalytics?.by_device?.length || 0} device types`}
          icon={BarChart3}
          iconClass="bg-violet-50 text-violet-600"
        />
      </div>

      {/* ROW 3: Alerts + Inventory */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatCard label="Raw Material Stock" value={fmtNum(summary.raw_material_stock)} sub={`${summary.raw_material_count} materials`} icon={Boxes} iconClass="bg-blue-50 text-blue-600" />
        <StatCard
          label="Open Alerts"
          value={alerts.total_open}
          sub={`${alerts.unread} unread · ${alerts.critical_unread} critical`}
          icon={BellRing}
          iconClass={alerts.total_open > 0 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}
          valueClass={alerts.total_open > 0 ? 'text-red-600' : ''}
        />
        <StatCard label="RM Shortages" value={rmShortage.length} sub="BOM-driven materials short" icon={PackageX} iconClass={rmShortage.length > 0 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'} valueClass={rmShortage.length > 0 ? 'text-red-600' : ''} />
        <StatCard
          label="Stock Alerts"
          value={lowStock.length}
          sub="items below min level"
          icon={AlertTriangle}
          iconClass={lowStock.length > 0 ? 'bg-amber-50 text-amber-600' : 'bg-green-50 text-green-600'}
          valueClass={lowStock.length > 0 ? 'text-amber-600' : 'text-green-600'}
        />
      </div>

      {/* ROW 4: Fulfilment health (sales pipeline by status) */}
      {fulfilment && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4 mb-6">
          <StatCard label="Open" value={fmtNum(fulfilment.groups.open.count)} sub={`₹${fmtNum(fulfilment.groups.open.value)}`} icon={ShoppingBag} iconClass="bg-amber-50 text-amber-600" />
          <StatCard label="In Production" value={fmtNum(fulfilment.groups.in_production.count)} sub={`₹${fmtNum(fulfilment.groups.in_production.value)}`} icon={Factory} iconClass="bg-blue-50 text-blue-600" />
          <StatCard label="Ready" value={fmtNum(fulfilment.groups.ready.count)} sub={`₹${fmtNum(fulfilment.groups.ready.value)}`} icon={Award} iconClass="bg-teal-50 text-teal-600" />
          <StatCard label="Dispatched" value={fmtNum(fulfilment.groups.dispatched.count)} sub={`₹${fmtNum(fulfilment.groups.dispatched.value)}`} icon={Truck} iconClass="bg-cyan-50 text-cyan-600" />
          <StatCard label="Stuck > 14d" value={fmtNum(fulfilment.stuck_orders)} sub="needs attention" icon={AlertTriangle} iconClass={fulfilment.stuck_orders > 0 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'} valueClass={fulfilment.stuck_orders > 0 ? 'text-red-600' : 'text-green-600'} />
        </div>
      )}

      {/* ROW 5: Trends */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title="Production Trend" subtitle="Daily production output (last 30 days)">
          {trends.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No trend data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={trends} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="gProd" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={50} />
                <Tooltip content={<TrendTooltip />} />
                <Area type="monotone" dataKey="production" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#gProd)" name="Production" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Revenue Trend" subtitle="Daily dispatch revenue (last 30 days)">
          {revenueTrend.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No revenue data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={revenueTrend}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={60} />
                <Tooltip content={<TrendTooltip />} />
                <Area type="monotone" dataKey="revenue" stroke="#10b981" strokeWidth={2.5} fill="url(#gRev)" name="Revenue" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* ROW 6: Top customers + Salesperson leaderboard */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title="Top Customers (90 days)" subtitle="By dispatch revenue — sales & marketing focus list">
          {salesByCustomer.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <div className="space-y-2">
              {salesByCustomer.map((c, i) => (
                <div key={c.customer_id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50">
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center text-sm font-bold
                    ${i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-slate-200 text-slate-700' : i === 2 ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700 truncate">{c.customer}</div>
                    <div className="text-xs text-slate-400">{c.code || '—'} · {fmtNum(c.dispatches)} dispatches</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-emerald-700">₹{fmtNum(c.revenue)}</div>
                    <div className="text-xs text-slate-400">{fmtNum(c.qty)} qty</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Salesperson Leaderboard (90 days)" subtitle="By dispatch revenue">
          {salesBySalesperson.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={salesBySalesperson.slice(0, 8)} layout="vertical" margin={{ left: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={100} />
                <Tooltip content={<TrendTooltip />} />
                <Bar dataKey="revenue" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Revenue" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* ROW 7: Pipelines + Inventory + Dispatch by Plant */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title="Orders Pipeline" subtitle="By status">
          {pipeline.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No pipeline data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pipeline} dataKey="count" nameKey="status" cx="50%" cy="50%" innerRadius={52} outerRadius={78} paddingAngle={2} stroke="#fff">
                  {pipeline.map((_, i) => <Cell key={i} fill={TREND_COLORS[i % TREND_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<DonutTooltip />} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Order Type Mix" subtitle="OEM · TRADING · MANUFACTURING · LOCAL">
          {orderTypeMix.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={orderTypeMix}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="type" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <Tooltip content={<TrendTooltip />} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} name="Count" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Dispatch by Plant" subtitle="Scheduled vs dispatched">
          {byPlant.length === 0 ? <div className="h-56 flex items-center justify-center text-sm text-slate-400">No plant data</div> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={byPlant.slice(0, 8)} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="plant" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} interval={0} angle={-22} textAnchor="end" height={46} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={50} />
                <Tooltip content={<TrendTooltip />} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="scheduled" fill="#cbd5e1" name="Scheduled" radius={[3, 3, 0, 0]} />
                <Bar dataKey="dispatched" fill="#f59e0b" name="Dispatched" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* ROW 8: Lower widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title="Production by Product" subtitle="Top finished goods" className="lg:col-span-2"
          actions={<Link to="/production" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">View all <ArrowRight size={14} /></Link>}>
          {byProduct.length === 0 ? <div className="text-sm text-slate-400 py-10 text-center">No production data</div> : (
            <div className="space-y-3">
              {byProduct.slice(0, 8).map((p) => {
                const pct = p.planned > 0 ? Math.min(100, (p.produced / p.planned) * 100) : 0
                return (
                  <div key={p.product} className="flex items-center gap-3" title={p.product}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700 truncate">{p.product}</div>
                      <div className="h-2 bg-slate-100 rounded-full mt-1 overflow-hidden">
                        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-green-500' : 'bg-amber-400'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-slate-600 shrink-0">{fmtNum(p.produced)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        <Card title="Top Products (90 days)" subtitle="By qty dispatched"
          actions={<Link to="/scan-analytics" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">Detail <ArrowRight size={14} /></Link>}>
          {topProducts.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">No data</div> : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {topProducts.slice(0, 8).map((p) => (
                <div key={p.product_id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-100">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-700 truncate">{p.model}</div>
                    <div className="text-xs text-slate-400 font-mono">{p.item_code}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-emerald-700">₹{fmtNum(p.revenue)}</div>
                    <div className="text-xs text-slate-400">{fmtNum(p.qty)} · {fmtNum(p.weight_kg)}kg</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ROW 9: Shortages + Stock alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title="Stock Alerts" subtitle="Items below minimum level"
          actions={<Link to="/inventory" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">Inventory <ArrowRight size={14} /></Link>}>
          {lowStock.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-sm text-slate-400 py-10 gap-2">
              <TrendingUp size={22} className="text-green-400" /> All stock levels are healthy
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {lowStock.slice(0, 10).map((item) => (
                <div key={`${item.product}-${item.plant}`} className="flex items-center justify-between px-3 py-2 rounded-lg bg-red-50 border border-red-100" title={item.product}>
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle size={15} className="text-red-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 truncate">{item.product}</div>
                      <div className="text-xs text-slate-400 truncate">{item.plant}</div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-red-600">{fmtNum(item.current_stock)}</div>
                    <div className="text-xs text-slate-400">min {fmtNum(item.min_level)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Raw Material Shortages" subtitle="BOM-driven"
          actions={<Link to="/material-requirements" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">Material Req <ArrowRight size={14} /></Link>}>
          {rmShortage.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-sm text-slate-400 py-10 gap-2">
              <TrendingUp size={22} className="text-green-400" /> No material shortages
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {rmShortage.slice(0, 10).map((it, i) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-amber-50 border border-amber-100" title={`Required ${it.required_quantity}, available ${it.available_quantity}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <PackageX size={15} className="text-amber-500 shrink-0" />
                    <div className="min-0">
                      <div className="text-sm font-medium text-slate-700 truncate">{it.raw_material_name}</div>
                      <div className="text-xs text-slate-400 truncate">{it.uom || ''} · {(it.products || []).join(', ').slice(0, 36)}</div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-red-600">{fmtNum(it.shortage_quantity)}</div>
                    <div className="text-xs text-slate-400">short</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
