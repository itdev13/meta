import { useEffect, useState } from 'react';
import { WaGlyph } from './icons';
import { APP_NAME } from './Topbar';

const STEPS = ['Connecting to your CRM…', 'Checking your account…', 'Almost ready…'];
// The fading-out copy is a fresh mount; keep it on the step the user last saw.
let lastStep = 0;

/**
 * Branded boot splash shown while the CRM session is exchanged. `leaving` fades it out over the
 * app (the parent keeps it mounted for the length of the fade, then unmounts it).
 */
export default function BootSplash({ leaving }) {
  const [step, setStep] = useState(() => (leaving ? lastStep : 0));

  useEffect(() => {
    lastStep = step;
    if (leaving || step >= STEPS.length - 1) return undefined;
    const t = setTimeout(() => setStep((s) => s + 1), 1200);
    return () => clearTimeout(t);
  }, [step, leaving]);

  return (
    <div className={`boot ${leaving ? 'boot-leaving' : ''}`} role="status" aria-live="polite" aria-busy={!leaving}>
      <div className="boot-center">
        <div className="boot-mark-wrap" aria-hidden="true">
          <span className="boot-ring" />
          <span className="boot-ring boot-ring-2" />
          <div className="boot-mark">
            <WaGlyph size={34} />
          </div>
        </div>
        <div className="boot-word">
          <span className="boot-name">{APP_NAME}</span>
          <span className="boot-for">for WhatsApp</span>
        </div>
        <div className="boot-bar" aria-hidden="true">
          <span />
        </div>
        <div className="boot-status">
          <span key={step}>{STEPS[step]}</span>
        </div>
      </div>
    </div>
  );
}
