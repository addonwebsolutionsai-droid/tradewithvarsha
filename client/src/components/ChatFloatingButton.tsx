/**
 * ChatFloatingButton — floating "🤖 Ask AI" bubble at bottom-right
 * (offset from the Tutorial button so they don't overlap). Opens a
 * compact chat panel anywhere on the site so users don't have to
 * navigate to the /ask-ai tab.
 *
 * Same backend as PublicChatPage: posts to /api/chat with the user's
 * query. LLM (Gemini) only summarises platform snapshots — never
 * invents numbers.
 */
import React, { useEffect, useRef, useState } from 'react'
import { chat } from '../api'

interface Message { role: 'user' | 'ai'; text: string; sources?: string[]; provider?: string }

export function ChatFloatingButton(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    { role: 'ai', text: 'Hi 👋 Vedicedge AI here. Ask anything about a stock, signal, or your trade. Try: "Should I buy RELIANCE?" or "JNKINDIA SL hit, what to do?"' },
  ])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, loading])

  const send = async () => {
    if (!query.trim() || loading) return
    const q = query.trim()
    setQuery('')
    setMessages(m => [...m, { role: 'user', text: q }])
    setLoading(true)
    try {
      const r = await chat.ask(q)
      setMessages(m => [...m, { role: 'ai', text: r.answer, sources: r.sourcesUsed, provider: r.llmProvider }])
    } catch (e) {
      setMessages(m => [...m, { role: 'ai', text: `⚠️ Error: ${(e as Error).message}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* Floating bubble — bottom-right, OFFSET from Tutorial (90px above) */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed right-6 z-50 rounded-full font-bold shadow-lg hover:scale-105 transition-transform border-2"
        style={{
          bottom: 88,   // Sits ABOVE the 🎓 Tutorial button (which is at bottom 24/right 24)
          width: 58, height: 58,
          background: 'linear-gradient(135deg,#b285ff 0%,#5fd4ff 100%)',
          color: '#0e0e16',
          fontSize: 24,
          borderColor: 'rgba(178,133,255,0.6)',
          boxShadow: '0 4px 20px rgba(178,133,255,0.45)',
        }}
        title="Ask Vedicedge AI — any trade question"
      >
        🤖
      </button>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed z-50 flex flex-col bg-ink-800 border-2 border-accent-violet/50 rounded-lg shadow-2xl"
          style={{
            bottom: 156,
            right: 24,
            width: 'min(420px, calc(100vw - 48px))',
            height: 'min(560px, calc(100vh - 200px))',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-500 bg-gradient-to-r from-accent-violet/20 to-accent-cyan/10 rounded-t-lg">
            <div>
              <div className="text-[13px] font-bold text-accent-violet">🤖 Vedicedge AI</div>
              <div className="text-[9px] text-neutral-500">Answers come only from platform data — never made up</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-neutral-400 hover:text-neutral-100 text-[20px] leading-none">×</button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {messages.map((m, i) => (
              <div key={i} className={`p-2.5 rounded-lg ${m.role === 'user'
                ? 'bg-accent-cyan/10 border border-accent-cyan/30 ml-6'
                : 'bg-ink-900/50 border border-ink-500 mr-6'}`}>
                <div className="text-[9px] uppercase tracking-wider mb-1 font-bold"
                     style={{ color: m.role === 'user' ? '#5fd4ff' : '#b285ff' }}>
                  {m.role === 'user' ? '👤 You' : '🤖 AI'}
                  {m.provider && m.provider !== 'fallback' && (
                    <span className="ml-2 text-neutral-600 font-normal">· {m.provider}</span>
                  )}
                </div>
                <div className="text-[12px] text-neutral-200 whitespace-pre-wrap leading-relaxed">{m.text}</div>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-1.5 text-[9px] text-neutral-600">
                    📎 {m.sources.slice(0, 4).join(' · ')}{m.sources.length > 4 ? ` +${m.sources.length - 4}` : ''}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="text-[11px] text-accent-violet animate-pulse pl-1">🤖 thinking...</div>
            )}
          </div>

          {/* Input */}
          <div className="p-2.5 border-t border-ink-500 bg-ink-900/40 rounded-b-lg">
            <div className="flex gap-2">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
                placeholder="Ask about a stock or trade..."
                className="flex-1 bg-ink-900 border border-ink-500 rounded px-2.5 py-1.5 text-[12px] text-neutral-200 focus:outline-none focus:border-accent-violet/60"
                disabled={loading}
                maxLength={1000}
              />
              <button onClick={send} disabled={loading || !query.trim()}
                className="px-3 py-1.5 rounded bg-accent-violet/20 text-accent-violet border border-accent-violet/50 font-bold text-[11px] hover:bg-accent-violet/30 disabled:opacity-40">
                {loading ? '...' : 'Send'}
              </button>
            </div>
            <div className="mt-1.5 text-[9px] text-neutral-600 leading-tight">
              ⚠️ Informational only, not financial advice. Final decisions are yours.
            </div>
          </div>
        </div>
      )}
    </>
  )
}
