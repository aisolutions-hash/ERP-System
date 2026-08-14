import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Search } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge } from '../components/ui'
import Table from '../components/Table'
import { RoleBadge } from '../lib/format'

const empty = { username: '', email: '', full_name: '', role: 'viewer', password: '' }

export default function Users() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    api
      .get('/users', { params: { search } })
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
    setForm({ ...empty, ...row, password: '' })
    setModal('edit')
  }
  const remove = async (row) => {
    if (!window.confirm(`Delete user "${row.username}"?`)) return
    await api.delete(`/users/${row.id}`)
    load()
  }
  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = { ...form }
      if (!payload.password) delete payload.password
      if (modal === 'create') await api.post('/users', payload)
      else await api.patch(`/users/${form.id}`, payload)
      setModal(null)
      load()
    } catch (err) {
      alert(err.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { key: 'username', label: 'Username', render: (r) => <span className="font-medium">{r.username}</span> },
    { key: 'full_name', label: 'Full Name', render: (r) => r.full_name || '—' },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: (r) => <RoleBadge role={r.role} /> },
    { key: 'is_active', label: 'Status', render: (r) => <Badge className={r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
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
        title="Users"
        subtitle="Manage system users and roles"
        actions={
          <button onClick={openCreate} className="inline-flex items-center gap-1.5 text-sm bg-slate-900 text-white rounded-lg px-3 py-2 hover:bg-slate-800">
            <Plus size={15} /> Add User
          </button>
        }
      />

      <Card
        actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user…"
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
        <Modal open title={modal === 'create' ? 'Add User' : 'Edit User'} onClose={() => setModal(null)}>
          <form onSubmit={save} className="space-y-4">
            {field('Username *', 'username', { required: true })}
            {field('Full Name', 'full_name')}
            {field('Email *', 'email', { type: 'email', required: true })}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
              >
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="store">Store</option>
                <option value="production">Production</option>
                <option value="dispatch">Dispatch</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            {field(modal === 'create' ? 'Password *' : 'New Password (leave blank to keep)', 'password', { type: 'password', required: modal === 'create' })}
            <div className="flex justify-end gap-2 pt-2">
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