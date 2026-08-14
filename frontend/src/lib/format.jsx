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