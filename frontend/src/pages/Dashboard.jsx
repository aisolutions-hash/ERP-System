import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ShoppingBag, Truck, Factory, Boxes, AlertTriangle, TrendingUp, ArrowRight,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import api from '../lib/api'
import { KpiCard, Card, Loading } from '../components/ui'
import { fmtNum } from '../lib/format'

const PIE_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4']

export default function Dashboard() {
  const [summary, setSummary] = useState(null)
  const [byPlant, setByPlant] = useState([])
  const [byProduct, setByProduct] = useState([])
  const [pipeline, setPipeline] = useState([])
  const [invStatus, setInvStatus] = useState([])
  const [trends, setTrends] = useState([])
  const [lowStock, setLowStock] = useState([])

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/summary'),
      api.get('/dashboard/dispatch-by-plant'),
      api.get('/dashboard/production-by-product'),
      api.get('/dashboard/order-pipeline'),
      api.get('/dashboard/inventory-status'),
      api.get('/dashboard/daily-trends'),
      api.get('/dashboard/low-stock-list'),
    ])
      .then(([s, bp, bpr, op, iv, tr, ls]) => {
        setSummary(s.data)
        setByPlant(bp.data.items)
        setByProduct(bpr.data.items)
        setPipeline(op.data.items)
        setInvStatus(iv.data.items)
        setTrends(tr.data.items)
        setLowStock(ls.data.items)
      })
      .catch(() => {})
  }, [])

  if (!summary) return <Loading />

  return (
    <div>
      <h2 className="text-xl font-bold text-slate-900 mb-1">Dashboard</h2>
      <p className="text-sm text-slate-500 mb-6">Overview for {summary.report_date}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Total Orders" value={fmtNum(summary.total_orders)} sub={`${summary.completed_orders} completed`} icon={ShoppingBag} />
        <KpiCard label="Dispatch Done" value={fmtNum(summary.dispatch_done)} sub={`of ${fmtNum(summary.dispatch_scheduled)} scheduled`} icon={Truck} />
        <KpiCard label="Production Output" value={fmtNum(summary.production_produced_qty)} sub={`${fmtNum(summary.production_pending_qty)} pending`} icon={Factory} />
        <KpiCard label="Raw Material Stock" value={fmtNum(summary.raw_material_stock)} sub={`${summary.raw_material_count} materials`} icon={Boxes} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title="Orders Pipeline" subtitle="By status" className="lg:col-span-1">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={pipeline} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={80} label>
                {pipeline.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Dispatch by Plant" subtitle="Scheduled vs dispatched" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byPlant.slice(0, 8)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="plant" tick={{ fontSize: 11 }} interval={0} angle={-25} textAnchor="end" height={55} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="scheduled" fill="#cbd5e1" name="Scheduled" />
              <Bar dataKey="dispatched" fill="#f59e0b" name="Dispatched" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title="Inventory Status" className="lg:col-span-1">
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={invStatus} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={65} label>
                {invStatus.map((_, i) => (
                  <Cell key={i} fill={['#10b981', '#f59e0b', '#ef4444'][i % 3]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Daily Trends" subtitle="Dispatch & production output (last 30 days)" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="production" fill="#8b5cf6" name="Production" />
              <Bar dataKey="dispatch" fill="#06b6d4" name="Dispatch" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card
          title="Production by Product"
          subtitle="Top finished goods"
          actions={
            <Link to="/production" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">
              View all <ArrowRight size={14} />
            </Link>
          }
        >
          <div className="space-y-3">
            {byProduct.slice(0, 8).map((p) => (
              <div key={p.product} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-700 truncate">{p.product}</div>
                  <div className="h-2 bg-gray-100 rounded-full mt-1 overflow-hidden">
                    <div
                      className="h-full bg-amber-400 rounded-full"
                      style={{
                        width: `${p.planned > 0 ? Math.min(100, (p.produced / p.planned) * 100) : 100}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="text-sm text-slate-600 font-medium">{fmtNum(p.produced)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card
          title="Low Stock Alerts"
          subtitle="Items below minimum level"
          actions={
            <Link to="/inventory" className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1">
              Inventory <ArrowRight size={14} />
            </Link>
          }
        >
          {lowStock.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
              <TrendingUp size={16} /> All stock levels are healthy
            </div>
          ) : (
            <div className="space-y-2">
              {lowStock.map((item) => (
                <div key={`${item.product}-${item.plant}`} className="flex items-center justify-between px-3 py-2 rounded-lg bg-red-50 border border-red-100">
                  <div className="flex items-center gap-2 min-w-0">
                    <AlertTriangle size={16} className="text-red-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-700 truncate">{item.product}</div>
                      <div className="text-xs text-slate-400">{item.plant}</div>
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
      </div>
    </div>
  )
}