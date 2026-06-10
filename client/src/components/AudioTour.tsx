/**
 * AudioTour — floating "🎓 Tutorial" button at bottom-right. When opened,
 * walks the user through every tab with text narration that uses the
 * browser's Web Speech API (free, native, supports Hindi `hi-IN` and
 * English `en-IN`/`en-US`).
 *
 * This is the closest free + portable equivalent to a recorded MP4 +
 * audio tutorial — no server-side TTS subscription required, and audio
 * plays through the user's own browser speakers in either language.
 *
 * If a browser lacks Hindi voice support (rare on iOS / older browsers),
 * the component falls back to English-only narration with a clear note.
 */
import React, { useEffect, useState } from 'react'

type Lang = 'en' | 'hi'

interface Step {
  id: string
  title: string
  en: string
  hi: string
}

const STEPS: Step[] = [
  {
    id: 'intro',
    title: 'Welcome',
    en: 'Welcome to Tradewithvarsha. This platform shows you 14 tabs of trading signals. The most important ones are PRO Edge, Options PRO, Smart Money, and SL Traps. Let me walk you through each.',
    hi: 'ट्रेडविथवर्षा में आपका स्वागत है। इस प्लेटफॉर्म पर 14 ट्रेडिंग सिग्नल टैब हैं। सबसे महत्वपूर्ण हैं प्रो एज, ऑप्शन्स प्रो, स्मार्ट मनी, और एस-एल ट्रैप्स। मैं आपको हर एक के बारे में बताता हूँ।',
  },
  {
    id: 'pro-edge',
    title: '💎 PRO Edge',
    en: 'PRO Edge is the strictest signal feed. A stock appears here only if all four filters pass: cross-engine confluence with at least two engines agreeing, smart-money on the same side, sector tailwind aligned, and conviction above 85. Target effective win rate is 80 to 85 percent. Position size: 5 percent of capital.',
    hi: 'प्रो एज सबसे सख्त सिग्नल फीड है। एक स्टॉक यहाँ तभी आता है जब चारों फिल्टर पास हों: कम से कम दो इंजन से कन्फ्लुएंस, स्मार्ट मनी एक तरफ, सेक्टर टेलविंड साथ, और कन्विक्शन 85 से ऊपर। लक्ष्य प्रभावी जीत दर 80 से 85 प्रतिशत है। पोजीशन साइज 5 प्रतिशत कैपिटल।',
  },
  {
    id: 'fno-options',
    title: '🎯 F&O Options',
    en: 'The F&O tab now includes a PRO Mode toggle. When ON, it shows only grade A NIFTY options with score 9 or higher, and the banner displays the live measured 30-day win rate pulled from accuracy dot json. Use limit order at mid of bid-ask, never at ask. SL is 30 percent of premium. Position size 1 to 2 percent capital per signal.',
    hi: 'एफ-एंड-ओ टैब में अब प्रो मोड टॉगल है। ऑन होने पर सिर्फ ग्रेड ए और 9 से ऊपर स्कोर वाले निफ्टी ऑप्शन्स दिखेंगे, और बैनर पर लाइव 30-दिन की मापी गई जीत दर एक्यूरेसी जेसन से आती है। लिमिट ऑर्डर बिड-आस्क के बीच में लगाएँ, कभी आस्क पर नहीं। एसएल प्रीमियम का 30 प्रतिशत। पोजीशन साइज 1 से 2 प्रतिशत कैपिटल।',
  },
  {
    id: 'smart-money',
    title: '🧲 Smart Money',
    en: 'Smart Money detects accumulation and distribution divergence using OBV, A D Line, and CMF. If price is flat or down but OBV is rising, institutions are buying secretly — green ACCUMULATION badge. If price is up but OBV falling, institutions are selling into retail strength — red DISTRIBUTION. Scale in over 3 to 5 sessions.',
    hi: 'स्मार्ट मनी ओबीवी, ए-डी लाइन, और सीएमएफ से एक्युमुलेशन और डिस्ट्रिब्यूशन डाइवर्जेंस पकड़ता है। प्राइस फ्लैट या नीचे लेकिन ओबीवी ऊपर मतलब संस्थान गुप्त रूप से खरीद रहे हैं — हरा एक्युमुलेशन बैज। प्राइस ऊपर लेकिन ओबीवी नीचे मतलब संस्थान रिटेल की ताकत में बेच रहे हैं — लाल डिस्ट्रिब्यूशन। 3 से 5 सेशन में धीरे-धीरे एंट्री लें।',
  },
  {
    id: 'sl-traps',
    title: '🛡️ SL Traps',
    en: 'This is the most important tab. When your stop loss hits, IMMEDIATELY check SL Traps. If the alert shows TRAP SUSPECTED with smart money accumulation, the SL was a liquidity grab. HOLD or re-enter at the SL price. Watch 5 sessions for reversal. Real examples: MOSCHIP, MARKSANS, FINPIPE — all hit SL then hit target within 5 days.',
    hi: 'यह सबसे ज़रूरी टैब है। जब आपका स्टॉप लॉस हिट हो, तुरंत एसएल ट्रैप्स देखें। अगर अलर्ट में ट्रैप सस्पेक्टेड दिखता है स्मार्ट मनी एक्युमुलेशन के साथ, तो एसएल लिक्विडिटी ग्रैब था। होल्ड करें या एसएल प्राइस पर फिर से एंट्री लें। 5 सेशन तक रिवर्सल देखें। उदाहरण: MOSCHIP, MARKSANS, FINPIPE — सबने एसएल हिट किया और 5 दिन में टारगेट भी।',
  },
  {
    id: 'sectors',
    title: '🔄 Sectors',
    en: 'Use the Sectors tab BEFORE entering any trade. If the sector is LEADING or IMPROVING, take full position size for longs. If WEAKENING or LAGGING, skip the long or take a short instead. The 20-day relative strength versus NIFTY is the key number.',
    hi: 'किसी भी ट्रेड से पहले सेक्टर्स टैब देखें। अगर सेक्टर लीडिंग या इम्प्रूविंग है, लॉन्ग के लिए फुल साइज लें। अगर वीकनिंग या लैगिंग है, लॉन्ग छोड़ें या शॉर्ट लें। निफ्टी के मुकाबले 20-दिन की रिलेटिव स्ट्रेंथ मुख्य संख्या है।',
  },
  {
    id: 'pro-mode',
    title: '🎯 PRO Mode toggle',
    en: 'On Cash Equity, Old Weekly, Ultra Picks, and Smart Money tabs, there is a PRO Mode toggle. When ON, only high-conviction signals matching the 80 percent win rate target are shown. Default is ON. Toggle OFF to see all raw signals.',
    hi: 'कैश इक्विटी, ओल्ड वीकली, अल्ट्रा पिक्स, और स्मार्ट मनी टैब्स पर एक प्रो मोड टॉगल है। ऑन होने पर सिर्फ हाई-कन्विक्शन सिग्नल दिखेंगे जो 80 प्रतिशत जीत दर के लक्ष्य से मेल खाते हैं। डिफॉल्ट ऑन है। सब रॉ सिग्नल देखने के लिए ऑफ करें।',
  },
  {
    id: 'risk',
    title: 'Risk Rules',
    en: 'Hard rules: Maximum 10 open positions at any time. Maximum 25 percent capital deployed. Never widen your stop loss on emotion. Always book 50 percent at T1 mechanically. The SL-Trap rule applies to every trade — never close on SL touch without checking the SL Traps tab.',
    hi: 'सख्त नियम: अधिकतम 10 खुली पोजीशन्स। अधिकतम 25 प्रतिशत कैपिटल इस्तेमाल। एसएल कभी भी इमोशन में बढ़ाएँ नहीं। टी-1 पर हमेशा 50 प्रतिशत मैकेनिकली बुक करें। एसएल-ट्रैप नियम हर ट्रेड पर लागू है — एसएल टच पर एसएल ट्रैप्स टैब देखे बिना कभी बंद न करें।',
  },
]

function pickVoice(lang: Lang): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null
  const voices = window.speechSynthesis.getVoices()
  const want = lang === 'hi' ? ['hi-IN', 'hi'] : ['en-IN', 'en-US', 'en-GB', 'en']
  for (const w of want) {
    const v = voices.find(v => v.lang === w)
    if (v) return v
  }
  return voices.find(v => v.lang.startsWith(lang === 'hi' ? 'hi' : 'en')) ?? null
}

export function AudioTour(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState<Lang>('en')
  const [stepIdx, setStepIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [voicesReady, setVoicesReady] = useState(false)
  const [hindiOK, setHindiOK] = useState(true)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    const checkVoices = () => {
      const v = window.speechSynthesis.getVoices()
      setVoicesReady(v.length > 0)
      const hasHi = v.some(x => x.lang.startsWith('hi'))
      setHindiOK(hasHi)
    }
    checkVoices()
    window.speechSynthesis.onvoiceschanged = checkVoices
  }, [])

  const speak = (text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice(lang)
    if (v) u.voice = v
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'
    u.rate = 0.95
    u.onstart = () => setPlaying(true)
    u.onend = () => setPlaying(false)
    u.onerror = () => setPlaying(false)
    window.speechSynthesis.speak(u)
  }

  const stop = () => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    setPlaying(false)
  }

  const playStep = (idx: number) => {
    setStepIdx(idx)
    const text = lang === 'hi' ? STEPS[idx].hi : STEPS[idx].en
    speak(text)
  }

  const next = () => playStep(Math.min(stepIdx + 1, STEPS.length - 1))
  const prev = () => playStep(Math.max(stepIdx - 1, 0))

  return (
    <>
      {/* Floating launcher button */}
      <button
        onClick={() => { setOpen(true); playStep(0) }}
        className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-full bg-accent-amber text-ink-900 font-bold shadow-lg hover:scale-105 transition-transform border-2 border-accent-amber/50"
        style={{ boxShadow: '0 4px 20px rgba(255,180,84,0.4)' }}
        title="Audio Tutorial — Hindi + English narration"
      >
        🎓 Tutorial
      </button>

      {/* Modal overlay */}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => { stop(); setOpen(false) }}>
          <div className="bg-ink-800 border-2 border-accent-amber/50 rounded-lg max-w-2xl w-full p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-[18px] font-bold text-accent-amber">🎓 Tradewithvarsha Tutorial</h2>
                <p className="text-[11px] text-neutral-400 mt-1">Step {stepIdx + 1} of {STEPS.length} · {playing ? '🔊 playing' : '⏸️ paused'}</p>
              </div>
              <button onClick={() => { stop(); setOpen(false) }} className="text-neutral-400 hover:text-neutral-100 text-[20px]">×</button>
            </div>

            {/* Language selector */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => { stop(); setLang('en'); setTimeout(() => playStep(stepIdx), 100) }}
                className={`px-3 py-1.5 rounded text-[12px] font-bold ${lang === 'en' ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/50' : 'bg-ink-700 text-neutral-400 border border-ink-500'}`}
              >🇬🇧 English</button>
              <button
                onClick={() => { stop(); setLang('hi'); setTimeout(() => playStep(stepIdx), 100) }}
                className={`px-3 py-1.5 rounded text-[12px] font-bold ${lang === 'hi' ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/50' : 'bg-ink-700 text-neutral-400 border border-ink-500'}`}
                disabled={!hindiOK}
                title={hindiOK ? 'Switch to Hindi narration' : 'Hindi voice not available on this browser'}
              >🇮🇳 हिन्दी {!hindiOK && '(unavailable)'}</button>
            </div>
            {lang === 'hi' && !hindiOK && (
              <div className="mb-3 px-3 py-2 rounded bg-accent-amber/10 border border-accent-amber/40 text-[10px] text-accent-amber">
                Hindi voice not detected on this device. Text shows in Hindi but audio plays in English. To enable: install Hindi system voice in your OS settings.
              </div>
            )}

            {/* Step content */}
            <div className="bg-ink-900/50 border border-ink-500 rounded p-4 mb-3 min-h-[180px]">
              <h3 className="text-[14px] font-bold text-accent-cyan mb-2">{STEPS[stepIdx].title}</h3>
              <p className="text-[13px] text-neutral-200 leading-relaxed" lang={lang === 'hi' ? 'hi-IN' : 'en-IN'}>
                {lang === 'hi' ? STEPS[stepIdx].hi : STEPS[stepIdx].en}
              </p>
            </div>

            {/* Step list */}
            <div className="flex flex-wrap gap-1 mb-3">
              {STEPS.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => playStep(i)}
                  className={`px-2 py-1 rounded text-[10px] ${i === stepIdx ? 'bg-accent-amber/20 text-accent-amber' : 'bg-ink-700 text-neutral-400 hover:bg-ink-600'}`}
                >{s.title}</button>
              ))}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button onClick={prev} disabled={stepIdx === 0} className="px-3 py-1.5 rounded text-[12px] bg-ink-700 text-neutral-300 disabled:opacity-40">← Prev</button>
                {playing ? (
                  <button onClick={stop} className="px-3 py-1.5 rounded text-[12px] bg-accent-red/20 text-accent-red border border-accent-red/40">⏹ Stop</button>
                ) : (
                  <button onClick={() => playStep(stepIdx)} className="px-3 py-1.5 rounded text-[12px] bg-accent-green/20 text-accent-green border border-accent-green/40">▶ Play</button>
                )}
                <button onClick={next} disabled={stepIdx === STEPS.length - 1} className="px-3 py-1.5 rounded text-[12px] bg-ink-700 text-neutral-300 disabled:opacity-40">Next →</button>
              </div>
              <div className="text-[10px] text-neutral-500">
                {voicesReady ? `voices loaded` : 'loading voices...'}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── ONE-TIME CHANGELOG POPUP ─────────────────────────────────
// Shows a single popup announcing recent changes. Persists "seen"
// flag in localStorage so it only appears once per user.
const CHANGELOG_VERSION = '2026-06-10'
const CHANGELOG: { title: string; bullets: string[] } = {
  title: '🆕 What\'s new in this build',
  bullets: [
    '🎯 PRO Mode toggle on Cash/Equity, Old-Weekly, Ultra Picks, Smart Money — targets 80%+ effective win rate. Default ON.',
    '🛡️ SL-Trap detector — catches liquidity grabs (MOSCHIP / MARKSANS / FINPIPE pattern). Effective WR counts confirmed trap-recoveries as wins.',
    '🎓 Audio Tutorial button (bottom-right) — Hindi + English narration walks you through every tab.',
    '📊 Daily Miss-Analyzer — cross-references today\'s top gainers vs our scanners; surfaces what we missed and why.',
    '📖 "How to Trade" boxes on every premium tab with explicit Entry / SL / Targets / Position Size rules.',
  ],
}

export function ChangelogPopup(): JSX.Element | null {
  const [show, setShow] = useState(false)

  useEffect(() => {
    try {
      const seen = localStorage.getItem('changelog-seen')
      if (seen !== CHANGELOG_VERSION) {
        // Delay slightly so it doesn't fight the tour button render
        setTimeout(() => setShow(true), 800)
      }
    } catch { /* ignore */ }
  }, [])

  const dismiss = () => {
    try { localStorage.setItem('changelog-seen', CHANGELOG_VERSION) } catch {}
    setShow(false)
  }

  if (!show) return null
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onClick={dismiss}>
      <div className="bg-ink-800 border-2 border-accent-cyan/50 rounded-lg max-w-lg w-full p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[16px] font-bold text-accent-cyan">{CHANGELOG.title}</h2>
          <button onClick={dismiss} className="text-neutral-400 hover:text-neutral-100 text-[20px]">×</button>
        </div>
        <p className="text-[11px] text-neutral-500 mb-3">Version {CHANGELOG_VERSION} · this notice shows only once</p>
        <ul className="space-y-2 text-[13px] text-neutral-200 list-none ml-0">
          {CHANGELOG.bullets.map((b, i) => (
            <li key={i} className="flex gap-2"><span className="text-accent-green mt-0.5">→</span><span>{b}</span></li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button onClick={dismiss} className="px-4 py-2 rounded bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40 text-[12px] font-bold hover:bg-accent-cyan/30">
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
