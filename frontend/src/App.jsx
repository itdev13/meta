import { useEffect, useState } from 'react';
import { onSessionExpired, startSession } from './lib/api';
import { Button, Empty, Spinner, ToastProvider } from './components/ui';
import { WaGlyph } from './components/icons';
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

function CrmApp() {
  const [state, setState] = useState({ phase: 'loading' });

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

  if (state.phase === 'loading') {
    return (
      <div className="center-screen">
        <div className="stack" style={{ alignItems: 'center', gap: 16 }}>
          <div className="brandmark" style={{ width: 52, height: 52, borderRadius: 16 }}>
            <WaGlyph size={30} />
          </div>
          <Spinner large />
        </div>
      </div>
    );
  }

  if (state.phase === 'error' || state.phase === 'expired') {
    return (
      <div className="center-screen">
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
      {state.user.scope === 'agency' ? <AgencyApp user={state.user} context={state.context} /> : <LocationApp user={state.user} />}
    </ToastProvider>
  );
}
