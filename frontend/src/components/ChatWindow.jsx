import React, { useState, useRef, useEffect, useCallback } from 'react';

function ThinkingTimer() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ color: '#555', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
      Thinking… ({sec}s)
    </div>
  );
}

export default function ChatWindow({ messages, onSend, disabled }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const submit = async () => {
    const text = input.trim();
    if (!text || loading || disabled) return;
    setInput('');
    setLoading(true);
    await onSend(text);
    setLoading(false);
  };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <p style={{ color: '#555', textAlign: 'center', marginTop: 40 }}>
            {disabled ? 'Start a session to begin.' : 'Send a message.'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '70%', padding: '10px 14px', borderRadius: 8,
            background: m.role === 'user' ? '#1d4ed8' : '#1e1e1e',
            fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap',
          }}>
            {m.content}
          </div>
        ))}
        {loading && <ThinkingTimer />}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: '12px 16px', borderTop: '1px solid #222', display: 'flex', gap: 8, boxSizing: 'border-box' }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled || loading}
          placeholder={disabled ? 'Session not active' : 'Message (Enter to send)'}
          rows={2}
          style={{
            flex: 1, minWidth: 0, background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
            color: '#e8e8e8', padding: '8px 12px', fontSize: 16, resize: 'none',
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={submit}
          disabled={disabled || loading || !input.trim()}
          style={btnStyle(disabled || loading || !input.trim())}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function btnStyle(disabled) {
  return {
    padding: '0 20px', borderRadius: 6, border: 'none',
    background: disabled ? '#333' : '#1d4ed8', color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    fontSize: 14, alignSelf: 'flex-end', height: 40,
  };
}
