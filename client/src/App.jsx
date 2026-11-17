import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Send from './pages/Send.jsx';
import Receive from './pages/Receive.jsx';
import AddMoney from './pages/AddMoney.jsx';
import CashOut from './pages/CashOut.jsx';
import Activity from './pages/Activity.jsx';
import TransactionDetail from './pages/TransactionDetail.jsx';
import Profile from './pages/Profile.jsx';
import Requests from './pages/Requests.jsx';
import { RequestCountProvider } from './requestCount.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page-loading"><span className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function GuestOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loading"><span className="spinner" /></div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
      <Route element={<RequireAuth><RequestCountProvider><Layout /></RequestCountProvider></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="send" element={<Send />} />
        <Route path="receive" element={<Receive />} />
        <Route path="add-money" element={<AddMoney />} />
        <Route path="cash-out" element={<CashOut />} />
        <Route path="activity" element={<Activity />} />
        <Route path="activity/:reference" element={<TransactionDetail />} />
        <Route path="profile" element={<Profile />} />
        <Route path="requests" element={<Requests />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
