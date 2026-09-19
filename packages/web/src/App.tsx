import { Navigate, Route, Routes } from 'react-router-dom';

import TopBar from './components/TopBar';
import Collect from './pages/Collect';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import Purchase from './pages/Purchase';
import Report from './pages/Report';
import Sell from './pages/Sell';

export default function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <main className="flex min-h-0 grow flex-col gap-5 px-10 pt-8 pb-9">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sell" element={<Sell />} />
          <Route path="/purchase" element={<Purchase />} />
          <Route path="/collect" element={<Collect />} />
          <Route path="/report" element={<Report />} />
          <Route path="/products" element={<Products />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
