import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export function Card({ title, subtitle, actions, children, className = '' }) {
  return (
    <div className={`bg-white rounded-xl border border-gray-200 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-slate-800">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function KpiCard({ label, value, sub, icon: Icon, color = 'text-slate-900' }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</div>
          <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
          {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
        </div>
        {Icon && (
          <div className="h-10 w-10 rounded-lg bg-amber-50 flex items-center justify-center">
            <Icon className="text-amber-600" size={20} />
          </div>
        )}
      </div>
    </div>
  )
}

export function Modal({ open, title, onClose, children, wide = false }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (open) {
      setVisible(true)
      document.body.style.overflow = 'hidden'
    } else {
      setVisible(false)
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={ref}
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div>
        <h2 className="text-xl font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Loading() {
  return (
    <div className="flex items-center justify-center py-20 text-slate-400 text-sm">
      Loading…
    </div>
  )
}

export function Empty({ text = 'No data found' }) {
  return <div className="text-center py-10 text-sm text-slate-400">{text}</div>
}

export function Badge({ children, className = 'bg-gray-100 text-gray-600' }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {children}
    </span>
  )
}