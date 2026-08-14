import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Boxes, ShoppingCart, Warehouse, Factory, ShoppingBag,
  Truck, Users, Package, FileDown, ShieldCheck, LogOut,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { RoleBadge } from '../lib/format'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/raw-materials', label: 'Raw Materials', icon: Boxes },
  { to: '/purchases', label: 'Purchases', icon: ShoppingCart },
  { to: '/inventory', label: 'Inventory', icon: Warehouse },
  { to: '/production', label: 'Production', icon: Factory },
  { to: '/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/dispatch', label: 'Dispatch', icon: Truck },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/suppliers', label: 'Suppliers', icon: Package },
  { to: '/reports', label: 'Reports', icon: FileDown },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const onLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-300 flex flex-col fixed inset-y-0">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="text-white font-bold text-lg">Kalika ERP</div>
          <div className="text-xs text-slate-400 mt-0.5">Enterprises</div>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-white border-l-2 border-amber-400'
                    : 'hover:bg-slate-800/60 hover:text-white'
                }`
              }
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <NavLink
              to="/users"
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-white border-l-2 border-amber-400'
                    : 'hover:bg-slate-800/60 hover:text-white'
                }`
              }
            >
              <ShieldCheck size={18} />
              Users
            </NavLink>
          )}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white font-medium">{user?.full_name || user?.username}</div>
              <div className="mt-1">
                <RoleBadge role={user?.role} />
              </div>
            </div>
            <button onClick={onLogout} title="Logout" className="text-slate-400 hover:text-white">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 ml-60 p-6">
        <Outlet />
      </main>
    </div>
  )
}