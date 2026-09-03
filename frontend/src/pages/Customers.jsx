import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Download, Search, Users, Building2 } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
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
    { key: 'code', label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code || '—'}</span> },
    { key: 'type', label: 'Type', render: (r) => <Badge className={r.is_plant ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}>{r.is_plant ? 'Plant' : 'Customer'}</Badge> },
    { key: 'contact_person', label: 'Contact', render: (r) => r.contact_person || '—' },
    { key: 'email', label: 'Email', render: (r) => r.email || '—' },
    { key: 'phone', label: 'Phone', render: (r) => <span className="font-mono text-xs">{r.phone || '—'}</span> },
    {
      key: 'actions', label: '',
      render: (r) => (
        <div className="flex gap-1.5">
          <button onClick={() => openEdit(r)} className="btn btn-ghost p-1.5" title="Edit"><Pencil size={15} /></button>
          <button onClick={() => remove(r)} className="btn btn-ghost p-1.5 text-red-400" title="Delete"><Trash2 size={15} /></button>
        </div>
      ),
    },
  ]

  const field = (label, key, props = {}) => (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <input
        value={form[key] ?? ''}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="input"
        {...props}
      />
    </div>
  )

  const plants = items.filter((i) => i.is_plant).length
  const regular = items.length - plants

  return (
    <div className="animate-fade-in-up">
      <PageHeader
        title="Customers"
        subtitle={`${items.length} customers & plants`}
        actions={
          <>
            <a href="/api/reports/customers/csv" className="btn btn-secondary"><Download size={15} /> CSV</a>
            <button onClick={openCreate} className="btn btn-primary"><Plus size={15} /> Add Customer</button>
          </>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Total Records" value={items.length} icon={Users} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Customers" value={regular} icon={Users} iconClass="bg-blue-50 text-blue-600" />
        <StatCard label="Plants" value={plants} icon={Building2} iconClass="bg-violet-50 text-violet-600" />
      </div>

      <Card
        actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer…"
              className="input input-icon sm:w-60"
            />
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={columns} data={items} keyField="id" stickyColumns={['name']} dense />
        )}
      </Card>

      {modal && (
        <Modal open title={modal === 'create' ? 'Add Customer' : 'Edit Customer'} onClose={() => setModal(null)} wide
          footer={<>
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </>}>
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
              <input type="checkbox" checked={!!form.is_plant} onChange={(e) => setForm({ ...form, is_plant: e.target.checked })} className="accent-amber-500" />
              This is a plant location
            </label>
          </form>
        </Modal>
      )}
    </div>
  )
}