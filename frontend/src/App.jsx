import React, { useState, useCallback, useRef } from 'react';
import SessionControl, { BootChecklist } from './components/SessionControl.jsx';
import ChatWindow from './components/ChatWindow.jsx';

const API_URL = import.meta.env.VITE_API_URL;
const API_KEY = import.meta.env.VITE_API_KEY;

const BLANK_STAGES = { launched: false, running: false, runtime: false, model: false, gateway: false };

export default function App() {
  const [session, setSession] = useState({ status: 'stopped', privateIp: null, instanceId: null });
  const [messages, setMessages] = useState([]);
  const [bootStages, setBootStages] = useState(BLANK_STAGES);
  const pollRef = useRef(null);
  const timeoutsRef = useRef([]);

  const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

  // Keep EC2 alive while user is idle on the ready screen (resets FastAPI idle timer)
  useEffect(() => {
    if (session.status !== 'ready' || !session.privateIp) return;
    const id = setInterval(() => {
      fetch(`${API_URL}/health`, { headers: { ...headers, 'x-private-ip': session.privateIp } })
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
      const res = await fetch(`${API_URL}/session`, { method: 'POST', headers });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      setSession({ status: 'error', error: err.message, privateIp: null, instanceId: null });
      return;
    }

    setSession({ status: data.status, privateIp: data.privateIp, instanceId: data.instanceId });
    setBootStages(s => ({ ...s, launched: true }));

    // Phase 1: poll GET /session until EC2 state = running
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/session`, { method: 'GET', headers });
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
                headers: { ...headers, 'x-private-ip': data.privateIp },
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
    await fetch(`${API_URL}/session`, { method: 'DELETE', headers });
    setSession({ status: 'stopped', privateIp: null, instanceId: null });
    setBootStages(BLANK_STAGES);
    setMessages([]);
  }, [clearAll]);

  const sendMessage = useCallback(async (text) => {
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);

    // Post chat — returns jobId immediately (avoids API GW 29s timeout)
    const chatHeaders = { ...headers, 'x-private-ip': session.privateIp };
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
          <span style={{ fontWeight: 700, letterSpacing: 1, flexShrink: 0 }}>
            SECURE LLM
            <span style={{ fontWeight: 400, fontSize: 10, color: '#444', marginLeft: 8, letterSpacing: 0.5 }}>v0.6</span>
          </span>
          <SessionControl session={session} bootStages={bootStages} onStart={startSession} onStop={stopSession} />
        </div>
        {(session.status === 'starting' || session.status === 'running') && (
          <BootChecklist bootStages={bootStages} />
        )}
      </header>
      <ChatWindow messages={messages} onSend={sendMessage} disabled={session.status !== 'ready'} />
    </div>
  );
}
