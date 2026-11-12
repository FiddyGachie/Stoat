import { useEffect, useState } from "react";

interface SplashScreenProps {
  onComplete?: () => void;
  minDisplayTimeMs?: number;
}

export function SplashScreen({ onComplete, minDisplayTimeMs = 1200 }: SplashScreenProps) {
  const [progress, setProgress] = useState(15);
  const [statusIndex, setStatusIndex] = useState(0);
  const [exiting, setExiting] = useState(false);

  const steps = [
    "Securing cryptographic session boundary…",
    "Connecting to PayPal Orders & Payouts rail…",
    "Calibrating AG Grid telemetry & double-entry ledger…",
    "Verified runtime ready.",
  ];

  useEffect(() => {
    // Hide static HTML splash from index.html if present
    const staticSplash = document.getElementById("stoat-static-splash");
    if (staticSplash) {
      staticSplash.remove();
    }

    const t1 = setTimeout(() => { setProgress(45); setStatusIndex(1); }, 350);
    const t2 = setTimeout(() => { setProgress(80); setStatusIndex(2); }, 750);
    const t3 = setTimeout(() => { setProgress(100); setStatusIndex(3); }, 1100);

    const finishTimer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => {
        onComplete?.();
      }, 450);
    }, minDisplayTimeMs);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(finishTimer);
    };
  }, [minDisplayTimeMs, onComplete]);

  const handleSkip = () => {
    setExiting(true);
    setTimeout(() => {
      onComplete?.();
    }, 200);
  };

  return (
    <div
      className={`splash-container ${exiting ? "splash-exit" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Stoat Console"
    >
      <div className="splash-card">
        <div className="splash-emblem-wrap">
          <div className="splash-emblem-aura" aria-hidden="true" />
          <img
            src="/stoat-brand-badge.svg"
            alt="Stoat Emblem"
            className="splash-emblem"
            width={76}
            height={76}
          />
        </div>

        <span className="splash-eyebrow">
          Verified Service Commerce
        </span>

        <h1 className="splash-title">Stoat</h1>
        <p className="splash-subtitle">
          Autonomous Agent Settlement Layer on PayPal
        </p>

        <div className="splash-progress-track" aria-hidden="true">
          <div
            className="splash-progress-bar"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="splash-status-row">
          <span className="splash-status-text">
            <span className="splash-status-dot" aria-hidden="true" />
            {steps[statusIndex]}
          </span>
          <button
            type="button"
            className="splash-skip-btn"
            onClick={handleSkip}
            aria-label="Skip splash screen"
          >
            Skip
          </button>
        </div>

        <div className="splash-badges" aria-hidden="true">
          <span className="splash-badge-item">PayPal Native</span>
          <span className="splash-badge-item">Fireworks AI</span>
          <span className="splash-badge-item">AG Grid &amp; Charts</span>
          <span className="splash-badge-item">Double-Entry Solvency</span>
        </div>
      </div>
    </div>
  );
}
