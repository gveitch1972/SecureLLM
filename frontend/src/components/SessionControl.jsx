import React from 'react';

const STATUS_COLOR = { stopped: '#666', starting: '#f59e0b', running: '#f59e0b', ready: '#22c55e' };
const STATUS_LABEL = { stopped: 'Stopped', starting: 'Starting…', running: 'Booting…', ready: 'Ready' };

export default function SessionControl({ session, onStart, onStop }) {
  const { status } = session;
  const busy = status === 'starting' || status === 'running';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: STATUS_COLOR[status] }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status], display: 'inline-block' }} />
        {STATUS_LABEL[status]}
      </span>
      {status === 'stopped' && (
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
    padding: '4px 14px', borderRadius: 4, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? '#333' : bg, color: '#fff', fontSize: 13, opacity: disabled ? 0.5 : 1,
  };
}
