import { useEffect, useState } from 'react'
import { Plus, Pencil, RefreshCw, CalendarClock, Factory, GitCompareArrows } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, PageTabs, StatCard } from '../components/ui'
import Table from '../components/Table'
import { fmtNum, CompletionBar } from '../lib/format'

const TABS = [
  { key: 'plan', label: 'Production Plan', icon: <CalendarClock size={15} /> },
  { key: 'actual', label: 'Actual Production', icon: <Factory size={15} /> },
  { key: 'pva', label: 'Plan vs Actual', icon: <GitCompareArrows size={15} /> },
]

export default function Production() {
  const [tab, setTab] = useState('plan')
  const [plans, setPlans] = useState([])
  const [actual, setActual] = useState([])
  const [pva, setPva] = useState([])
  const [unlinked, setUnlinked] = useState([])
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showPlanForm, setShowPlanForm] = useState(false)
  const [showActualForm, setShowActualForm] = useState(false)
  const [form, setForm] = useState({})

  const loadProducts = () => api.get('/products', { params: { page_size: 500 } })
    .then((r) => setProducts(r.data.items || [])).catch(() => {})
  const loadCustomers = () => api.get('/customers', { params: { page_size: 500 } })
    .then((r) => setCustomers(r.data.items || [])).catch(() => {})

  const loadPlans = () => api.get('/plans', { params: { plan_type: 'PRODUCTION_PLAN', page_size: 500 } })
    .then((r) => setPlans(r.data.items || [])).catch(() => [])
  const loadActual = () => api.get('/production/actual', { params: { page_size: 500 } })
    .then((r) => setActual(r.data.items || [])).catch(() => [])
  const loadPva = () => api.get('/production/plan-vs-actual')
    .then((r) => { setPva(r.data.items || []); setUnlinked(r.data.unlinked_plans || []) }).catch(() => [])

  const load = () => {
    setLoading(true)
    return Promise.all([loadPlans(), loadActual(), loadPva()]).finally(() => setLoading(false))
  }

  useEffect(() => { load(); loadProducts(); loadCustomers() }, [])

  const savePlan = () => {
    const payload = {
      plan_type: 'PRODUCTION_PLAN', model: form.model || '',
      product_id: form.product_id || null, customer_id: form.customer_id || null,
      quantity: form.quantity != null ? Number(form.quantity) : null,
      owner: form.owner || '', status: form.status || 'PENDING',
      plan_date: form.plan_date || new Date().toISOString().slice(0, 10),
      remarks: form.remarks || '',
    }
    if (form.id) {
      api.patch(`/plans/${form.id}`, payload).then(() => { setShowPlanForm(false); setForm({}); loadPlans() })
    } else {
      api.post('/plans', payload).then(() => { setShowPlanForm(false); setForm({}); loadPlans() })
    }
  }

  const planCols = [
    { key: 'plan_date', label: 'Plan Date', render: (r) => r.plan_date || '—' },
    { key: 'customer', label: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'owner', label: 'Owner / Salesperson', render: (r) => r.owner || '—' },
    { key: 'model', label: 'Product / Model', render: (r) => r.model || r.product?.model || '—' },
    { key: 'quantity', label: 'Planned Qty', render: (r) => <span className="font-semibold">{fmtNum(r.quantity)}</span> },
    { key: 'status', label: 'Status', render: (r) => <Badge className={sc[r.status]} dot>{r.status}</Badge> },
    { key: 'remarks', label: 'Remarks', render: (r) => <span className="text-slate-500 text-xs">{r.remarks || '—'}</span> },
    { key: 'edit', label: '', render: (r) => (
      <button onClick={() => { setForm({ id: r.id, model: r.model, product_id: r.product_id, customer_id: r.customer_id, quantity: r.quantity, owner: r.owner, status: r.status, plan_date: r.plan_date, remarks: r.remarks }); setShowPlanForm(true) }} className="text-slate-400 hover:text-slate-700 p-1 hover:bg-gray-100 rounded" title="Edit"><Pencil size={15} /></button>
    )},
  ]

  const actualCols = [
    { key: 'production_date', label: 'Production Date', render: (r) => r.production_date || '—' },
    { key: 'model', label: 'Product', render: (r) => <span className="font-medium">{r.model || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'quantity', label: 'Actual Produced', render: (r) => <span className="font-semibold">{fmtNum(r.quantity)}</span> },
    { key: 'ref', label: 'Reference / Production Order', render: (r) => <span className="font-mono text-xs">{r.ref || '—'}</span> },
  ]

  const pvaCols = [
    { key: 'model', label: 'Product / Model', render: (r) => <span className="font-semibold">{r.model || '—'}</span> },
    { key: 'item_code', label: 'Item Code', render: (r) => <span className="font-mono text-xs">{r.item_code || '—'}</span> },
    { key: 'planned_qty', label: 'Planned Qty', render: (r) => fmtNum(r.planned_qty) },
    { key: 'actual_qty', label: 'Actual Produced', render: (r) => fmtNum(r.actual_qty) },
    { key: 'remaining_qty', label: 'Remaining', render: (r) => <span className={r.remaining_qty < 0 ? 'text-red-600 font-semibold' : ''}>{fmtNum(r.remaining_qty)}</span> },
    { key: 'completion_pct', label: 'Completion', render: (r) => <div className="min-w-36"><CompletionBar value={r.completion_pct} /></div> },
    { key: 'status', label: 'Status', render: (r) => <Badge className={sc[r.status]} dot>{r.status}</Badge> },
    { key: 'report_date', label: 'Report Date', render: (r) => r.report_date || '—' },
  ]

  const unlinkedCols = [
    { key: 'model', label: 'Model', render: (r) => r.model || '—' },
    { key: 'customer', label: 'Customer', render: (r) => r.customer || '—' },
    { key: 'owner', label: 'Owner', render: (r) => r.owner || '—' },
    { key: 'planned_qty', label: 'Planned Qty', render: (r) => fmtNum(r.planned_qty) },
    { key: 'plan_date', label: 'Plan Date', render: (r) => r.plan_date || '—' },
    { key: 'linkage', label: 'Linkage', render: (r) => <span className="text-amber-600 text-xs">{r.linkage}</span> },
  ]

  const totalPlanned = plans.reduce((s, p) => s + (Number(p.quantity) || 0), 0)
  const totalActual = actual.reduce((s, p) => s + (Number(p.quantity) || 0), 0)
  const totalPvaPlanned = pva.reduce((s, p) => s + (Number(p.planned_qty) || 0), 0)
  const totalPvaActual = pva.reduce((s, p) => s + (Number(p.actual_qty) || 0), 0)
  const doneCount = pva.filter((p) => (p.remaining_qty || 0) <= 0).length

  const renderTab = () => {
    if (tab === 'plan') {
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard label="Planned Records" value={plans.length} icon={CalendarClock} iconClass="bg-amber-50 text-amber-600" />
            <StatCard label="Total Planned Qty" value={fmtNum(totalPlanned)} icon={Factory} iconClass="bg-violet-50 text-violet-600" />
            <StatCard label="Customers" value={new Set(plans.map((p) => p.customer?.name || '').filter(Boolean)).size} icon={Factory} iconClass="bg-blue-50 text-blue-600" />
          </div>
          <Card title="Production Plan" actions={
            <button onClick={() => { setForm({}); setShowPlanForm(true) }} className="btn btn-primary"><Plus size={15} /> New Plan</button>
          }>
            {loading ? <Loading /> : plans.length === 0 ? <Empty text="No production plans found" /> : <Table columns={planCols} data={plans} keyField="id" stickyColumns={['model']} />}
          </Card>
        </div>
      )
    }
    if (tab === 'actual') {
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard label="Daily Records" value={actual.length} icon={Factory} iconClass="bg-violet-50 text-violet-600" />
            <StatCard label="Total Actual Qty" value={fmtNum(totalActual)} icon={Factory} iconClass="bg-green-50 text-green-600" />
            <StatCard label="Days Tracked" value={new Set(actual.map((p) => p.production_date)).size} icon={CalendarClock} iconClass="bg-cyan-50 text-cyan-600" />
          </div>
          <Card title="Actual Production (daily)" actions={
            <button onClick={() => setShowActualForm(true)} className="btn btn-primary"><Plus size={15} /> Record Output</button>
          }>
            {loading ? <Loading /> : actual.length === 0 ? <Empty text="No actual output recorded" /> : <Table columns={actualCols} data={actual} keyField="id" stickyColumns={['model']} />}
          </Card>
        </div>
      )
    }
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Production Orders" value={pva.length} icon={Factory} iconClass="bg-violet-50 text-violet-600" />
          <StatCard label="Total Planned" value={fmtNum(totalPvaPlanned)} icon={CalendarClock} iconClass="bg-amber-50 text-amber-600" />
          <StatCard label="Total Produced" value={fmtNum(totalPvaActual)} icon={Factory} iconClass="bg-green-50 text-green-600" />
          <StatCard label="Completed" value={doneCount} icon={GitCompareArrows} iconClass="bg-blue-50 text-blue-600" />
        </div>
        <Card title="Plan vs Actual — by Production Order">
          {loading ? <Loading /> : pva.length === 0 ? <Empty text="No production orders" /> : (
            <Table columns={pvaCols} data={pva} keyField="plan_id" stickyColumns={['model']} dense />
          )}
        </Card>
        {unlinked.length > 0 && (
          <Card title="Plan-only records (no reliable plan-to-actual link)">
            <div className="mb-2 text-xs text-amber-600">Actual exists / Plan linkage unavailable — not fabricated.</div>
            <Table columns={unlinkedCols} data={unlinked} keyField="plan_id" stickyColumns={['model']} />
          </Card>
        )}
      </div>
    )
  }

  return (
    <div className="animate-fade-in-up">
      <PageHeader title="Production" subtitle="Production plans, daily actual output, and plan-vs-actual summary"
        actions={
          <button onClick={load} className="btn btn-secondary"><RefreshCw size={15} /> Refresh</button>
        } />

      <PageTabs tabs={TABS} active={tab} onChange={setTab} />

      {renderTab()}

      {/* Plan create/edit modal */}
      <Modal open={showPlanForm} title={form.id ? 'Edit Production Plan' : 'New Production Plan'} onClose={() => setShowPlanForm(false)} wide
        footer={<>
          <button onClick={() => setShowPlanForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={savePlan} className="btn btn-primary">Save Plan</button>
        </>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Model / Product</label>
            <select value={form.product_id ?? ''} onChange={(e) => setForm({ ...form, product_id: e.target.value ? Number(e.target.value) : null, model: products.find((p) => p.id === Number(e.target.value))?.model || form.model })} className="input">
              <option value="">Select product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.model} {p.item_code ? `(${p.item_code})` : ''}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Model (override)</label>
            <input value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Customer</label>
            <select value={form.customer_id ?? ''} onChange={(e) => setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : null })} className="input">
              <option value="">None</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Planned Qty</label>
            <input type="number" value={form.quantity ?? ''} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Owner / Salesperson</label>
            <input value={form.owner || ''} onChange={(e) => setForm({ ...form, owner: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Plan Date</label>
            <input type="date" value={form.plan_date || ''} onChange={(e) => setForm({ ...form, plan_date: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Status</label>
            <select value={form.status || 'PENDING'} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
              <option>PENDING</option><option>IN_PROCESS</option><option>COMPLETED</option>
            </select></div>
          <div className="sm:col-span-2"><label className="block text-slate-500 text-xs mb-1">Remarks</label>
            <textarea value={form.remarks || ''} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="input" rows={2} /></div>
        </div>
      </Modal>

      {/* Actual record modal */}
      <Modal open={showActualForm} title="Record Daily Production Output" onClose={() => setShowActualForm(false)}
        footer={<>
          <button onClick={() => setShowActualForm(false)} className="btn btn-secondary">Cancel</button>
          <button onClick={async () => {
            try { await api.post(`/production/${form.order_id}/movements`, null, { params: { quantity: Number(form.quantity), production_date: form.production_date } }); setShowActualForm(false); setForm({}); loadActual(); loadPva() }
            catch (e) { alert('Failed to record output') }
          }} className="btn btn-primary">Save Output</button>
        </>}>
        <div className="grid grid-cols-1 gap-3 text-sm">
          <div><label className="block text-slate-500 text-xs mb-1">Production Order (ref)</label>
            <select value={form.order_id ?? ''} onChange={(e) => setForm({ ...form, order_id: e.target.value ? Number(e.target.value) : null })} className="input">
              <option value="">Select production order…</option>
              {Array.from(new Map(pva.map((p) => [p.plan_id, p])).values()).map((p) => <option key={p.plan_id} value={p.plan_id}>{p.model} — planned {fmtNum(p.planned_qty)}</option>)}
            </select></div>
          <div><label className="block text-slate-500 text-xs mb-1">Quantity</label>
            <input type="number" value={form.quantity ?? ''} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" /></div>
          <div><label className="block text-slate-500 text-xs mb-1">Production Date</label>
            <input type="date" value={form.production_date || ''} onChange={(e) => setForm({ ...form, production_date: e.target.value })} className="input" /></div>
        </div>
      </Modal>
    </div>
  )
}

const sc = {
  PENDING: 'bg-amber-100 text-amber-700',
  IN_PROCESS: 'bg-blue-100 text-blue-700',
  'In Process': 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  Completed: 'bg-green-100 text-green-700',
  Planned: 'bg-slate-100 text-slate-600',
}