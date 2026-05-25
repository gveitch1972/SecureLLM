import React, { useState, useEffect, useRef } from 'react';

const STAGES = [
  { id: 'launched', label: 'Instance launched',         detail: 'EC2 instance requested from AWS…',           expectedMs:  5000 },
  { id: 'running',  label: 'Instance running',          detail: 'Waiting for OS to initialise…',              expectedMs: 45000 },
  { id: 'runtime',  label: 'Installing Ollama runtime', detail: 'Downloading Ollama binary, starting server…', expectedMs: 80000 },
  { id: 'model',    label: 'Loading llama3.2:1b',       detail: 'Pulling model weights into memory…',         expectedMs: 30000 },
  { id: 'gateway',  label: 'Secure gateway ready',      detail: 'Starting FastAPI — pinging /health…',        expectedMs: 120000 },
];

function lerpColor(a, b, t) {
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  return `rgb(${Math.round(ar+(br-ar)*t)},${Math.round(ag+(bg-ag)*t)},${Math.round(ab+(bb-ab)*t)})`;
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, flexShrink: 0,
      border: '1.5px solid #f59e0b44',
      borderTopColor: '#f59e0b',
      borderRadius: '50%',
      animation: 'spin-cw 0.8s linear infinite',
    }} />
  );
}

// Isolated timer component — only this re-renders every 500ms, not the whole checklist
function ActiveStageDetail({ detail, expectedMs }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 500);
    return () => clearInterval(t);
  }, [detail]);

  const sec = Math.floor(elapsed / 1000);
  const progress = Math.min(1, elapsed / expectedMs);
  const color = lerpColor('#888888', '#f59e0b', progress);

  return (
    <span style={{ fontSize: 11, color, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60vw' }}>
      {detail}{sec > 0 ? ` (${sec}s)` : ''}
    </span>
  );
}

export function BootChecklist({ bootStages }) {
  const currentIdx = STAGES.findIndex(s => !bootStages[s.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {STAGES.map((s, i) => {
        const done = bootStages[s.id];
        const active = i === currentIdx;
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ width: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 1 }}>
              {done
                ? <span style={{ color: '#22c55e', fontSize: 13, lineHeight: 1 }}>✓</span>
                : active
                  ? <Spinner />
                  : <span style={{ color: '#2a2a2a', fontSize: 13, lineHeight: 1 }}>○</span>
              }
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12, letterSpacing: '0.03em', color: done ? '#22c55e' : active ? '#f59e0b' : '#333' }}>
                {s.label}
              </span>
              {active && <ActiveStageDetail detail={s.detail} expectedMs={s.expectedMs} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function SessionControl({ session, bootStages, onStart, onStop }) {
  const { status, error } = session;
  const busy = status === 'starting' || status === 'running';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {status === 'stopped' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#555' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#333', display: 'inline-block' }} />
          Stopped
        </span>
      )}
      {status === 'error' && (
        <span style={{ fontSize: 13, color: '#ef4444' }} title={error}>Launch failed</span>
      )}
      {busy && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#f59e0b' }}>
          <Spinner /> Booting…
        </span>
      )}
      {status === 'ready' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#22c55e' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block', boxShadow: '0 0 6px #22c55e' }} />
          Ready
        </span>
      )}
      {(status === 'stopped' || status === 'error') && (
        <button onClick={onStart} style={btnStyle('#1d4ed8')}>Start Session</button>
      )}
      {(status === 'ready' || busy) && (
        <button onClick={onStop} disabled={busy} style={btnStyle('#7f1d1d', busy)}>Stop</button>
      )}
    </div>
  );
}

function btnStyle(bg, disabled = false) {
  return {
    padding: '4px 14px', borderRadius: 4, border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? '#2a2a2a' : bg,
    color: disabled ? '#555' : '#fff',
    fontSize: 13,
    flexShrink: 0,
  };
}
