import React, { useState, useCallback } from 'react';
import SessionControl from './components/SessionControl.jsx';
import ChatWindow from './components/ChatWindow.jsx';

const API_URL = import.meta.env.VITE_API_URL;
const API_KEY = import.meta.env.VITE_API_KEY;

export default function App() {
  const [session, setSession] = useState({ status: 'stopped', privateIp: null, instanceId: null });
  const [messages, setMessages] = useState([]);

  const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

  const startSession = useCallback(async () => {
    setSession(s => ({ ...s, status: 'starting' }));
    const res = await fetch(`${API_URL}/session`, { method: 'POST', headers });
    const data = await res.json();
    setSession({ status: data.status, privateIp: data.privateIp, instanceId: data.instanceId });

    // Poll until FastAPI is responding
    const poll = setInterval(async () => {
      try {
        const check = await fetch(`${API_URL}/health`, {
          headers: { ...headers, 'x-private-ip': data.privateIp },
        });
        if (check.ok) {
          setSession(s => ({ ...s, status: 'ready' }));
          clearInterval(poll);
        }
      } catch (_) { /* still booting */ }
    }, 5000);
  }, []);

  const stopSession = useCallback(async () => {
    await fetch(`${API_URL}/session`, { method: 'DELETE', headers });
    setSession({ status: 'stopped', privateIp: null, instanceId: null });
    setMessages([]);
  }, []);

  const sendMessage = useCallback(async (text) => {
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);

    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { ...headers, 'x-private-ip': session.privateIp },
      body: JSON.stringify({ model: 'llama3:8b', messages: next }),
    });
    const data = await res.json();
    const reply = data.message?.content ?? data.error ?? 'No response';
    setMessages(m => [...m, { role: 'assistant', content: reply }]);
  }, [messages, session.privateIp]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ padding: '12px 20px', borderBottom: '1px solid #222', display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontWeight: 700, letterSpacing: 1 }}>SECURE LLM</span>
        <SessionControl session={session} onStart={startSession} onStop={stopSession} />
      </header>
      <ChatWindow messages={messages} onSend={sendMessage} disabled={session.status !== 'ready'} />
    </div>
  );
}
