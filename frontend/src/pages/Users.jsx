import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Search, Users as UsersIcon, UserCheck, ShieldCheck } from 'lucide-react'
import api from '../lib/api'
import { PageHeader, Card, Modal, Loading, Empty, Badge, StatCard } from '../components/ui'
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
    { key: 'username', label: 'Username', render: (r) => <span className="font-mono text-xs font-medium">{r.username}</span> },
    { key: 'full_name', label: 'Full Name', render: (r) => r.full_name || '—' },
    { key: 'email', label: 'Email', render: (r) => r.email || '—' },
    { key: 'role', label: 'Role', render: (r) => <RoleBadge role={r.role} /> },
    { key: 'is_active', label: 'Status', render: (r) => <Badge className={r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
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

  const active = items.filter((i) => i.is_active).length
  const admins = items.filter((i) => i.role === 'admin').length

  return (
    <div className="animate-fade-in-up">
      <PageHeader
        title="Users"
        subtitle="Manage system users and roles"
        actions={<button onClick={openCreate} className="btn btn-primary"><Plus size={15} /> Add User</button>}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Total Users" value={items.length} icon={UsersIcon} iconClass="bg-amber-50 text-amber-600" />
        <StatCard label="Active" value={active} icon={UserCheck} iconClass="bg-green-50 text-green-600" valueClass="text-green-600" />
        <StatCard label="Admins" value={admins} icon={ShieldCheck} iconClass="bg-violet-50 text-violet-600" />
      </div>

      <Card
        actions={
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user…"
              className="input input-icon sm:w-56"
            />
          </div>
        }
      >
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty />
        ) : (
          <Table columns={columns} data={items} keyField="id" stickyColumns={['username']} dense />
        )}
      </Card>

      {modal && (
        <Modal open title={modal === 'create' ? 'Add User' : 'Edit User'} onClose={() => setModal(null)}
          footer={<>
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save'}</button>
          </>}>
          <form onSubmit={save} className="space-y-4">
            {field('Username *', 'username', { required: true })}
            {field('Full Name', 'full_name')}
            {field('Email *', 'email', { type: 'email', required: true })}
            <div>
              <label className="block text-xs text-slate-500 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="input"
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
          </form>
        </Modal>
      )}
    </div>
  )
}