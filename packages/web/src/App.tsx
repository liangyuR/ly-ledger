import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import TopBar from './components/TopBar';
import { useOnboarding } from './hooks/useOnboarding';
import Collect from './pages/Collect';
import Dashboard from './pages/Dashboard';
import Onboarding from './pages/Onboarding';
import Products from './pages/Products';
import Purchase from './pages/Purchase';
import Report from './pages/Report';
import SaleDetail from './pages/SaleDetail';
import Sell from './pages/Sell';

/**
 * 全新的库自动进向导。
 *
 * 只在**一个商品一笔生意都没有**时跳一次，跳完就不再管 —— 老板从向导里
 * 退出来是为了看看别的，再被弹回去就成了走不出的圈。往后靠看板上的清单。
 */
function FirstRunRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = useOnboarding();
  const jumped = useRef(false);

  useEffect(() => {
    if (jumped.current || !state.data) return;
    if (!state.data.fresh || state.data.dismissed) return;
    if (location.pathname !== '/') return;
    jumped.current = true;
    navigate('/onboarding', { replace: true });
  }, [state.data, location.pathname, navigate]);

  return null;
}

export default function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <FirstRunRedirect />
      <main className="flex min-h-0 grow flex-col gap-5 overflow-y-auto px-10 pt-8 pb-9">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sell" element={<Sell />} />
          <Route path="/purchase" element={<Purchase />} />
          <Route path="/collect" element={<Collect />} />
          <Route path="/report" element={<Report />} />
          <Route path="/sales/:id" element={<SaleDetail />} />
          <Route path="/products" element={<Products />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
