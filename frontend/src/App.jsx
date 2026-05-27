import React, { useState, useCallback, useRef, useEffect } from 'react';
import SessionControl, { BootChecklist } from './components/SessionControl.jsx';
import ChatWindow from './components/ChatWindow.jsx';

const API_URL = import.meta.env.VITE_API_URL;
const FREE_KEY = import.meta.env.VITE_API_KEY;

const BLANK_STAGES = { launched: false, running: false, runtime: false, model: false, gateway: false };

export default function App() {
  const [session, setSession] = useState({ status: 'stopped', privateIp: null, instanceId: null });
  const [messages, setMessages] = useState([]);
  const [bootStages, setBootStages] = useState(BLANK_STAGES);
  const [userKey, setUserKey] = useState(() => localStorage.getItem('securellm_key') || '');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const pollRef = useRef(null);
  const timeoutsRef = useRef([]);

  const activeKey = userKey || FREE_KEY;
  const isNamedUser = !!userKey;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const mkHeaders = () => ({ 'Content-Type': 'application/json', 'x-api-key': activeKeyRef.current });

  const saveKey = () => {
    const k = keyDraft.trim();
    if (k) { localStorage.setItem('securellm_key', k); setUserKey(k); }
    setShowKeyInput(false);
    setKeyDraft('');
  };

  const clearKey = () => {
    localStorage.removeItem('securellm_key');
    setUserKey('');
    setShowKeyInput(false);
  };

  // Keep EC2 alive while user is idle on the ready screen (resets FastAPI idle timer)
  useEffect(() => {
    if (session.status !== 'ready' || !session.privateIp) return;
    const ip = session.privateIp;
    const id = setInterval(() => {
      fetch(`${API_URL}/health`, { headers: { ...mkHeaders(), 'x-private-ip': ip } })
        .catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [session.status, session.privateIp]);

  const clearAll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  }, []);

  const startSession = useCallback(async () => {
    clearAll();
    setBootStages(BLANK_STAGES);
    setSession(s => ({ ...s, status: 'starting' }));

    let data;
    try {
      const res = await fetch(`${API_URL}/session`, { method: 'POST', headers: mkHeaders() });
      data = await res.json();
      if (!res.ok) {
        const msg = data.message || data.error || `HTTP ${res.status}`;
        const friendly = msg === 'Limit Exceeded'
          ? 'Daily request limit reached — resets at midnight UTC'
          : msg === 'Forbidden'
          ? 'API key invalid or missing'
          : msg;
        throw new Error(friendly);
      }
    } catch (err) {
      setSession({ status: 'error', error: err.message, privateIp: null, instanceId: null });
      return;
    }

    setSession({ status: data.status, privateIp: data.privateIp, instanceId: data.instanceId });
    setBootStages(s => ({ ...s, launched: true }));

    const sessionIp = data.privateIp;

    // Phase 1: poll GET /session until EC2 state = running
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/session`, { method: 'GET', headers: mkHeaders() });
        const d = await res.json();
        if (d.status === 'running') {
          clearInterval(pollRef.current);
          setBootStages(s => ({ ...s, running: true }));

          // Time-based ticks for stages we can't detect externally
          timeoutsRef.current.push(setTimeout(() =>
            setBootStages(s => ({ ...s, runtime: true })), 60000));
          timeoutsRef.current.push(setTimeout(() =>
            setBootStages(s => ({ ...s, model: true })), 120000));

          // Phase 2: poll /health until FastAPI responds
          pollRef.current = setInterval(async () => {
            try {
              const check = await fetch(`${API_URL}/health`, {
                headers: { ...mkHeaders(), 'x-private-ip': sessionIp },
              });
              if (check.ok) {
                clearAll();
                setBootStages({ launched: true, running: true, runtime: true, model: true, gateway: true });
                setSession(s => ({ ...s, status: 'ready' }));
              }
            } catch (_) {}
          }, 5000);
        }
      } catch (_) {}
    }, 5000);
  }, [clearAll]);

  const stopSession = useCallback(async () => {
    clearAll();
    await fetch(`${API_URL}/session`, { method: 'DELETE', headers: mkHeaders() });
    setSession({ status: 'stopped', privateIp: null, instanceId: null });
    setBootStages(BLANK_STAGES);
    setMessages([]);
  }, [clearAll]);

  const sendMessage = useCallback(async (text) => {
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);

    // Post chat — returns jobId immediately (avoids API GW 29s timeout)
    const chatHeaders = { ...mkHeaders(), 'x-private-ip': session.privateIp };
    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ model: 'llama3.2:1b', messages: next }),
    });
    const data = await res.json();
    if (!res.ok || !data.jobId) {
      const detail = data.error || data.message || JSON.stringify(data);
      setMessages(m => [...m, { role: 'assistant', content: `Error: ${detail}` }]);
      return;
    }
    const { jobId } = data;

    // Return Promise so ChatWindow keeps loading=true (shows "Thinking…") until done
    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`${API_URL}/result/${jobId}`, { headers: chatHeaders });
          const d = await r.json();
          if (d.status === 'done') {
            clearInterval(poll);
            const reply = d.result?.message?.content ?? 'No response';
            setMessages(m => [...m, { role: 'assistant', content: reply }]);
            resolve();
          } else if (d.status === 'error') {
            clearInterval(poll);
            setMessages(m => [...m, { role: 'assistant', content: `Error: ${d.error}` }]);
            resolve();
          }
        } catch (_) {}
      }, 2000);
    });
  }, [messages, session.privateIp]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #222', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ fontWeight: 700, letterSpacing: 1 }}>
              SECURE LLM
              <span style={{ fontWeight: 400, fontSize: 10, color: '#444', marginLeft: 8, letterSpacing: 0.5 }}>v0.6</span>
            </span>
            <button
              onClick={() => { setShowKeyInput(v => !v); setKeyDraft(''); }}
              title={isNamedUser ? 'Full access — click to manage key' : 'Free tier (50 req/day) — click to enter access key'}
              style={{ background: 'none', border: '1px solid #333', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11, color: isNamedUser ? '#22c55e' : '#555', letterSpacing: 0.3 }}
            >
              {isNamedUser ? '✓ Full access' : 'Free tier'}
            </button>
          </div>
          <SessionControl session={session} bootStages={bootStages} onStart={startSession} onStop={stopSession} />
        </div>
        {showKeyInput && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
            {isNamedUser ? (
              <>
                <span style={{ fontSize: 12, color: '#555' }}>Key active.</span>
                <button onClick={clearKey} style={smallBtn('#7f1d1d')}>Remove key</button>
                <button onClick={() => setShowKeyInput(false)} style={smallBtn('#1a1a1a')}>Cancel</button>
              </>
            ) : (
              <>
                <input
                  autoFocus
                  value={keyDraft}
                  onChange={e => setKeyDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveKey()}
                  placeholder="Paste access key…"
                  style={{ flex: 1, maxWidth: 320, padding: '4px 8px', borderRadius: 4, border: '1px solid #333', background: '#111', color: '#ccc', fontSize: 12, outline: 'none' }}
                />
                <button onClick={saveKey} disabled={!keyDraft.trim()} style={smallBtn('#1d4ed8', !keyDraft.trim())}>Save</button>
                <button onClick={() => setShowKeyInput(false)} style={smallBtn('#1a1a1a')}>Cancel</button>
              </>
            )}
          </div>
        )}
        {(session.status === 'starting' || session.status === 'running') && (
          <BootChecklist bootStages={bootStages} />
        )}
      </header>
      <ChatWindow messages={messages} onSend={sendMessage} disabled={session.status !== 'ready'} />
    </div>
  );
}

function smallBtn(bg, disabled = false) {
  return {
    padding: '3px 10px', borderRadius: 4, border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? '#2a2a2a' : bg,
    color: disabled ? '#555' : '#ccc',
    fontSize: 11,
    flexShrink: 0,
  };
}
