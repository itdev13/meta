import { useEffect, useRef } from 'react';
import { API_BASE, getToken } from './api';

/**
 * One shared EventSource per page for number status events (QR, pairing code, connected…).
 * EventSource reconnects by itself; listeners survive reconnects.
 */
let source = null;
const listeners = new Set();

function ensureSource() {
  if (source || !getToken()) return;
  source = new EventSource(`${API_BASE}/api/live?token=${encodeURIComponent(getToken())}`);
  source.addEventListener('status', (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    for (const fn of listeners) fn(data);
  });
}

export function useLiveStatus(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureSource();
    const fn = (evt) => ref.current(evt);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
}
