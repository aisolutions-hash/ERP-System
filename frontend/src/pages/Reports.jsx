import { PageHeader, Card } from '../components/ui'
import {
  FileSpreadsheet, FileText, FileDown, Factory, Truck, ShoppingBag, Boxes, Warehouse,
} from 'lucide-react'

const reports = [
  { title: 'Complete Excel Report', desc: 'All modules in one workbook (inventory, production, dispatch, orders, purchases, masters)', href: '/api/reports/excel', icon: FileSpreadsheet, color: 'bg-green-50 text-green-600' },
  { title: 'Inventory CSV', desc: 'Stock levels with status', href: '/api/reports/inventory/csv', icon: Warehouse, color: 'bg-blue-50 text-blue-600' },
  { title: 'Stock Movements CSV', desc: 'Every receipt/issue/dispatch movement', href: '/api/reports/movements/csv', icon: FileText, color: 'bg-violet-50 text-violet-600' },
  { title: 'Raw Materials CSV', desc: 'Material schedule, inward & balance', href: '/api/reports/raw-materials/csv', icon: Boxes, color: 'bg-amber-50 text-amber-600' },
  { title: 'Production CSV', desc: 'Production orders & output', href: '/api/reports/production/csv', icon: Factory, color: 'bg-orange-50 text-orange-600' },
  { title: 'Dispatch CSV', desc: 'Dispatch schedule vs actual', href: '/api/reports/dispatch/csv', icon: Truck, color: 'bg-cyan-50 text-cyan-600' },
  { title: 'Orders CSV', desc: 'Sales orders & status', href: '/api/reports/orders/csv', icon: ShoppingBag, color: 'bg-rose-50 text-rose-600' },
  { title: 'Purchases CSV', desc: 'Purchase orders', href: '/api/reports/purchases/csv', icon: FileDown, color: 'bg-slate-50 text-slate-600' },
  { title: 'Customers CSV', desc: 'Customer & plant master', href: '/api/reports/customers/csv', icon: FileText, color: 'bg-teal-50 text-teal-600' },
  { title: 'Suppliers CSV', desc: 'Supplier master', href: '/api/reports/suppliers/csv', icon: FileText, color: 'bg-indigo-50 text-indigo-600' },
  { title: 'Products CSV', desc: 'All products by category', href: '/api/reports/products/csv', icon: Boxes, color: 'bg-yellow-50 text-yellow-600' },
]

export default function Reports() {
  return (
    <div>
      <PageHeader
        title="Reports & Exports"
        subtitle="Download data as CSV or a combined Excel workbook"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {reports.map((r) => (
          <a
            key={r.href}
            href={r.href}
            className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 hover:shadow-md hover:border-amber-300 transition"
          >
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center mb-3 ${r.color}`}>
              <r.icon size={20} />
            </div>
            <div className="font-semibold text-slate-800">{r.title}</div>
            <div className="text-xs text-slate-500 mt-1">{r.desc}</div>
          </a>
        ))}
      </div>
    </div>
  )
}