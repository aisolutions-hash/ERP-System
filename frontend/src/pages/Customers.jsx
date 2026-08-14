import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Download, Search } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'

const empty = { name: '', code: '', company: '', contact_person: '', phone: '', email: '', address: '', gstin: '', is_plant: false, notes: '' }

export default function Customers() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    api
      .get('/customers', { params: { search } })
      .then((res) => setItems(res.data.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])
  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [search])

  const openCreate = () => {
    setForm(empty)
    setModal('create')
  }

  const openEdit = (row) => {
    setForm({ ...empty, ...row })
    setModal('edit')
  }

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      if (modal === 'create') {
        await api.post('/customers', form)
      } else {
        await api.patch(`/customers/${form.id}`, form)
      }
      setModal(null)
      load()
    } catch (err) {
      alert(err.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row) => {
    if (!window.confirm(`Delete customer "${row.name}"?`)) return
    await api.delete(`/customers/${row.id}`)
    load()
  }

  const columns = [
    { key: 'name', label: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'code', label: 'Code', render: (r) => r.code || '—' },
    { key: 'type', label: 'Type', render: (r) => <Badge className={r.is_plant ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}>{r.is_plant ? 'Plant' : 'Customer'}</Badge> },
    { key: 'contact_person', label: 'Contact', render: (r) => r.contact_person || '—' },
    { key: 'email', label: 'Email', render: (r) => r.email || '—' },
    { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex gap-2">
          <button onClick={() => openEdit(r)} className="text-slate-400 hover:text-slate-700"><Pencil size={15} /></button>
          <button onClick={() => remove(r)} className="text-slate-400 hover:text-red-600"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const field = (label, key, props = {}) => (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <input
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
        {...props}
      />
    </div>
  )

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={`${items.length} customers & plants`}
        actions={
          <>
            <a href="/api/reports/customers/csv" className="inline-flex items-center gap-1.5 text-sm bg-white border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
              <Download size={15} /> CSV
            </a>
            <button onClick={openCreate} className="inline-flex items-center gap-1.5 text-sm bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800">
              <Plus size={15} /> Add Customer
            </button>
          </>
        }
      />

      <Card
        actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer…"
              className="pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={columns} data={items} keyField="id" />
        )}
      </Card>

      {modal && (
        <Modal open title={modal === 'create' ? 'Add Customer' : 'Edit Customer'} onClose={() => setModal(null)} wide>
          <form onSubmit={save} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {field('Name *', 'name', { required: true })}
            {field('Code', 'code')}
            {field('Company', 'company')}
            {field('Contact Person', 'contact_person')}
            {field('Phone', 'phone')}
            {field('Email', 'email')}
            {field('GSTIN', 'gstin')}
            <div className="md:col-span-2">{field('Address', 'address')}</div>
            <div className="md:col-span-2">{field('Notes', 'notes')}</div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={!!form.is_plant} onChange={(e) => setForm({ ...form, is_plant: e.target.checked })} className="h-4 w-4" />
              This is a plant location
            </label>
            <div className="md:col-span-2 flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-60">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}