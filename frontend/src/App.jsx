import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import RawMaterials from './pages/RawMaterials'
import Purchases from './pages/Purchases'
import Inventory from './pages/Inventory'
import Production from './pages/Production'
import Orders from './pages/Orders'
import Dispatch from './pages/Dispatch'
import Customers from './pages/Customers'
import Suppliers from './pages/Suppliers'
import Reports from './pages/Reports'
import Users from './pages/Users'

function RequireAuth({ children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return children
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="raw-materials" element={<RawMaterials />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="production" element={<Production />} />
            <Route path="orders" element={<Orders />} />
            <Route path="dispatch" element={<Dispatch />} />
            <Route path="customers" element={<Customers />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="reports" element={<Reports />} />
            <Route path="users" element={<Users />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App