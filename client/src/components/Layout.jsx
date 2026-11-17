import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDownLeft, Banknote, Bell, History, Home, LifeBuoy, LogOut, Plus, Send, UserRound } from 'lucide-react';
import { useRequestCount } from '../requestCount.jsx';
import { useAuth } from '../auth.jsx';
import { Avatar, Logo } from './ui.jsx';
import { page } from './motion.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/send', label: 'Send', icon: Send },
  { to: '/receive', label: 'Receive', icon: ArrowDownLeft },
  { to: '/add-money', label: 'Add money', icon: Plus },
  { to: '/cash-out', label: 'Cash out', icon: Banknote },
  { to: '/activity', label: 'Activity', icon: History },
];

const MOBILE_NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/activity', label: 'Activity', icon: History },
  { to: '/send', label: 'Send', icon: Send, primary: true },
  { to: '/receive', label: 'Receive', icon: ArrowDownLeft },
  { to: '/profile', label: 'Me', icon: UserRound },
];

const isActive = (pathname, to, end) => (end ? pathname === to : pathname.startsWith(to));

export default function Layout() {
  const { user, logout, config } = useAuth();
  const helpUrl = config?.investigationUrl;
  const navigate = useNavigate();
  const location = useLocation();
  const outlet = useOutlet();
  const { count: requestCount } = useRequestCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => { setMenuOpen(false); window.scrollTo({ top: 0 }); }, [location.pathname]);
  useEffect(() => {
    const close = (e) => menuRef.current && !menuRef.current.contains(e.target) && setMenuOpen(false);
    const onScroll = () => setScrolled(window.scrollY > 8);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', onScroll); };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app">
      <div className="bg-mesh" aria-hidden="true" />
      <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
        <div className="topbar-inner">
          <Link to="/" className="brand"><Logo /></Link>
          <nav className="mainnav">
            {NAV.map(({ to, label, icon: Icon, end }) => {
              const active = isActive(location.pathname, to, end);
              return (
                <NavLink key={to} to={to} end={end} className={active ? 'active' : ''}>
                  {active && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 450, damping: 34 }} />}
                  <Icon size={17} />
                  <span>{label}</span>
                </NavLink>
              );
            })}
          </nav>
          {helpUrl && (
            <a href={helpUrl} className="bell help-link" aria-label="Payment help" title="Payment help: report a problem with a payment">
              <LifeBuoy size={19} />
            </a>
          )}
          <Link to="/requests" className={`bell${location.pathname === '/requests' ? 'active' : ''}`} aria-label={`Requests${requestCount ? ` (${requestCount} waiting)` : ''}`}>
            <motion.span key={requestCount} animate={requestCount ? { rotate: [0, -16, 14, -8, 0] } : {}} transition={{ duration: 0.6 }} style={{ display: 'grid' }}>
              <Bell size={19} />
            </motion.span>
            <AnimatePresence>
              {requestCount > 0 && (
                <motion.span className="bell-count" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 20 }}>
                  {requestCount > 9 ? '9+' : requestCount}
                </motion.span>
              )}
            </AnimatePresence>
          </Link>
          <div className="usermenu" ref={menuRef}>
            <button className="usermenu-trigger" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
              <Avatar name={user.name} size={36} ring />
              <span className="usermenu-name">{user.name.split(' ')[0]}</span>
            </button>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  className="usermenu-dropdown"
                  initial={{ opacity: 0, y: -8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="usermenu-head">
                    <Avatar name={user.name} size={42} />
                    <div>
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </div>
                  </div>
                  <Link to="/profile"><UserRound size={17} /> Profile & wallet</Link>
                  {helpUrl && <a href={helpUrl}><LifeBuoy size={17} /> Payment help</a>}
                  <button onClick={handleLogout} className="danger"><LogOut size={17} /> Log out</button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <main className="content">
        {/* New pages fade in; the old page is removed straight away. Waiting for exit animations
            (AnimatePresence mode="wait") could get stuck on pages with nested animations, leaving a blank screen. */}
        <motion.div key={location.pathname} variants={page} initial="initial" animate="animate">
          {/* A crash inside one page shows a recovery card; the menu keeps working and navigating resets it. */}
          <ErrorBoundary resetKey={location.pathname}>{outlet}</ErrorBoundary>
        </motion.div>
      </main>

      <footer className="footer">FastPay demo · Payments are simulated or run in the PayPal Sandbox. No real money moves.</footer>

      <nav className="tabbar">
        {MOBILE_NAV.map(({ to, label, icon: Icon, end, primary }) => {
          const active = isActive(location.pathname, to, end);
          return (
            <NavLink key={to} to={to} end={end} className={`${active ? 'active' : ''} ${primary ? 'primary' : ''}`}>
              {primary ? (
                <motion.span className="tabbar-fab" whileTap={{ scale: 0.9 }}><Icon size={22} /></motion.span>
              ) : (
                <>
                  <Icon size={21} />
                  <span>{label}</span>
                  {active && <motion.span layoutId="tab-dot" className="tab-dot" />}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
