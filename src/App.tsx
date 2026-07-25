import { Routes, Route, Navigate } from 'react-router'
import AdminLayout from './components/AdminLayout'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import ProductDetail from './pages/ProductDetail'
import Categories from './pages/Categories'
import Brands from './pages/Brands'
import Inventory from './pages/Inventory'
import Orders from './pages/Orders'
import Stores from './pages/Stores'
import Promotions from './pages/Promotions'
import HomeSections from './pages/HomeSections'
import Customers from './pages/Customers'

export default function App() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/brands" element={<Brands />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/stores" element={<Stores />} />
        <Route path="/promotions" element={<Promotions />} />
        <Route path="/home-sections" element={<HomeSections />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
