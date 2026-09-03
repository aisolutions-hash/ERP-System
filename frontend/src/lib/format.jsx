const roleLabels = {
  admin: 'Admin',
  manager: 'Manager',
  store: 'Store',
  production: 'Production',
  dispatch: 'Dispatch',
  viewer: 'Viewer',
}

const roleColors = {
  admin: 'bg-purple-100 text-purple-700',
  manager: 'bg-blue-100 text-blue-700',
  store: 'bg-emerald-100 text-emerald-700',
  production: 'bg-amber-100 text-amber-700',
  dispatch: 'bg-cyan-100 text-cyan-700',
  viewer: 'bg-gray-100 text-gray-600',
}

export function RoleBadge({ role }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${roleColors[role] || roleColors.viewer}`}>
      {roleLabels[role] || role}
    </span>
  )
}

export function StatusBadge({ status }) {
  const s = (status || '').toLowerCase()
  let cls = 'bg-gray-100 text-gray-600'
  if (s.includes('complet') || s === 'done' || s === 'delivered') cls = 'bg-green-100 text-green-700'
  else if (s.includes('progress') || s.includes('partial') || s.includes('dispatch')) cls = 'bg-blue-100 text-blue-700'
  else if (s === 'pending' || s === 'planned' || s === 'new' || s === 'confirmed') cls = 'bg-amber-100 text-amber-700'
  else if (s.includes('cancel')) cls = 'bg-red-100 text-red-600'
  else if (s === 'ready') cls = 'bg-teal-100 text-teal-700'
  else if (s === 'ordered' || s === 'in transit') cls = 'bg-cyan-100 text-cyan-700'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status}
    </span>
  )
}

export function fmtNum(v) {
  const n = Number(v)
  if (Number.isNaN(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function fmtPct(v) {
  const n = Number(v)
  if (Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

// Consistent operational status colour system (colour only; backend values untouched).
export const FLOW_BADGES = {
  // fulfilment decisions
  READY_FOR_DISPATCH: { label: 'Ready for Dispatch', cls: 'bg-green-100 text-green-700', dot: true },
  PRODUCTION_REQUIRED: { label: 'Production Required', cls: 'bg-blue-100 text-blue-700', dot: true },
  PURCHASE_REQUIRED: { label: 'Purchase Required', cls: 'bg-cyan-100 text-cyan-700', dot: true },
  MANUAL_DECISION_REQUIRED: { label: 'Manual Decision', cls: 'bg-purple-100 text-purple-700', dot: true },
  FULFILLED: { label: 'Fulfilled', cls: 'bg-slate-100 text-slate-600', dot: true },
  OVER_FULFILLED: { label: 'Over-fulfilled', cls: 'bg-red-100 text-red-700', dot: true },
  // requirements
  READY: { label: 'Ready', cls: 'bg-green-100 text-green-700', dot: true },
  SHORTAGE: { label: 'Shortage', cls: 'bg-red-100 text-red-700', dot: true },
  NO_BOM: { label: 'No BOM', cls: 'bg-amber-100 text-amber-700', dot: true },
  // delivery
  Completed: { label: 'Completed', cls: 'bg-green-100 text-green-700', dot: true },
  'Partially Dispatched': { label: 'Partial', cls: 'bg-amber-100 text-amber-700', dot: true },
  'Not Dispatched': { label: 'Not Dispatched', cls: 'bg-red-100 text-red-700', dot: true },
  Pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700', dot: true },
  'Over-fulfilled (line)': { label: 'Over-fulfilled', cls: 'bg-red-100 text-red-700', dot: true },
}

export function FlowBadge({ status, className }) {
  const meta = FLOW_BADGES[status] || { label: status || '—', cls: 'bg-white text-slate-500' }
  return (
    <span className={`badge ${meta.cls} ${className || ''}`}>
      {meta.dot && <span className="badge-dot" />}
      {meta.label}
    </span>
  )
}

export function CompletionBar({ value, className = '' }) {
  const pct = Math.max(0, Math.min(100, Number(value || 0) * 100))
  let color = 'bg-amber-400'
  if (pct >= 100) color = 'bg-green-500'
  else if (pct > 0) color = 'bg-amber-400'
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden min-w-10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[0.6875rem] text-slate-500 w-11 text-right shrink-0">{pct.toFixed(1)}%</span>
    </div>
  )
}

export function initials(name = '') {
  return name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}