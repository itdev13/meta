import { useEffect, useState } from 'react';
import { onSessionExpired, startSession } from './lib/api';
import { Button, Empty, ToastProvider } from './components/ui';
import BootSplash from './components/BootSplash';
import AgencyApp from './pages/agency/AgencyApp';
import LocationApp from './pages/location/LocationApp';
import ConnectPage from './pages/public/ConnectPage';

// Public share link (/connect/:token): no CRM login, so it must render before the SSO boot.
const CONNECT_MATCH = typeof window !== 'undefined' ? /^\/connect\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname) : null;

/**
 * One build, two experiences: opened from the agency menu → agency console; opened inside a
 * sub-account → that sub-account's WhatsApp page. The scope comes from the CRM's signed user
 * context, exchanged for a session token at /auth/session.
 */
export default function App() {
  if (CONNECT_MATCH) {
    return (
      <ToastProvider>
        <ConnectPage token={CONNECT_MATCH[1]} />
      </ToastProvider>
    );
  }
  return <CrmApp />;
}

const SPLASH_FADE_MS = 360;

function CrmApp() {
  const [state, setState] = useState({ phase: 'loading' });
  // 'on' while booting → 'leaving' (fades out over the app) → 'off'.
  const [splash, setSplash] = useState('on');

  const boot = async () => {
    setState({ phase: 'loading' });
    try {
      const session = await startSession();
      setState({ phase: 'ready', ...session });
    } catch (err) {
      setState({ phase: 'error', message: err.message });
    }
  };

  useEffect(() => {
    onSessionExpired(() => setState({ phase: 'expired' }));
    boot();
  }, []);

  useEffect(() => {
    if (state.phase === 'loading') {
      setSplash('on');
      return undefined;
    }
    setSplash((s) => (s === 'off' ? 'off' : 'leaving'));
    const t = setTimeout(() => setSplash('off'), SPLASH_FADE_MS);
    return () => clearTimeout(t);
  }, [state.phase]);

  if (state.phase === 'loading') return <BootSplash />;

  const overlay = splash === 'leaving' ? <BootSplash leaving /> : null;

  if (state.phase === 'error' || state.phase === 'expired') {
    return (
      <div className="center-screen">
        {overlay}
        <Empty
          icon={state.phase === 'expired' ? 'refresh' : 'alert'}
          title={state.phase === 'expired' ? 'Your session expired' : 'Couldn’t open WhatsApp'}
          action={
            <Button variant="primary" onClick={boot}>
              {state.phase === 'expired' ? 'Reload' : 'Try again'}
            </Button>
          }
        >
          {state.phase === 'expired' ? 'Reload to continue where you left off.' : state.message}
        </Empty>
      </div>
    );
  }

  return (
    <ToastProvider>
      {overlay}
      {state.user.scope === 'agency' ? <AgencyApp user={state.user} context={state.context} /> : <LocationApp user={state.user} />}
    </ToastProvider>
  );
}
