import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'

import { useLiveWebSocket } from './ws'
import { useStore } from './store'
import { api } from './api'

import { Header } from './components/Header'
import { MarketBar } from './components/MarketBar'
import { TabNav } from './components/TabNav'

import { SignalsPage } from './pages/SignalsPage'
import { IntradayPage } from './pages/IntradayPage'
import { OptionsPage } from './pages/OptionsPage'
import { SwingPage } from './pages/SwingPage'
import { CommodityPage } from './pages/CommodityPage'
import { GannPage } from './pages/GannPage'
import { BacktestPage } from './pages/BacktestPage'
import { BacktestResultsPage } from './pages/BacktestResultsPage'
import { HarmonicPage } from './pages/HarmonicPage'
import { BotPage } from './pages/BotPage'
import { MoneyFlowPage } from './pages/MoneyFlowPage'
import { SwingScanPage } from './pages/SwingScanPage'
import { MultibaggerPage } from './pages/MultibaggerPage'
import { PreMovePage } from './pages/PreMovePage'
import { MoversPage } from './pages/MoversPage'
import { ProScreenerPage } from './pages/ProScreenerPage'
import { LearningPage } from './pages/LearningPage'
import { WeeklyPickPage } from './pages/WeeklyPickPage'
import { DailyPickPage } from './pages/DailyPickPage'
import { TurtleSoupPage } from './pages/TurtleSoupPage'
import { DashboardHome } from './pages/DashboardHome'
import { PreviewDashboard } from './pages/PreviewDashboard'
import { GannCyclePage } from './pages/GannCyclePage'
import { TimeCyclePage } from './pages/TimeCyclePage'
import { SymbolsPage } from './pages/SymbolsPage'
import { LiveFeedSidebar } from './components/LiveFeedSidebar'
import { TopTradesPage } from './pages/TopTradesPage'
import { PreMoveIdentifierPage } from './pages/PreMoveIdentifierPage'
import { LoginPage, SignupPage, ProfilePage, AdminUsersPage, RequireAuth } from './pages/AuthPages'
import { PublicTopTradesPage, PublicWeeklyPickPage, PublicDailyPickPage, PublicPreMovePage, PublicOptionsPage, PublicIntradayPage, PublicSignalsHistoryPage, PublicPreMoveIdentifierPage, PublicPicksHub, PublicEliteHub, PublicOIBuildupPage, PublicFnoFuturesPage, PublicOldWeeklyPickPage, PublicSectorRotationPage, PublicCrossConfluencePage, PublicAdDivergencePage, PublicProEdgePage, PublicSlTrapPage, PublicChatPage, PublicArchivePage, PublicSuperstarPicksPage, PublicBulkDealsPage, PublicEarlyMomentumPage, PublicPedigreeAccumulationPage, PublicXRecsPage, PublicChartPatternsPage, PublicInsiderBuysPage, PublicNiftyForesightPage, PublicVolumeProfilePage, PublicElitePicksPage, PublicStockFnoVolumeProfilePage, PublicJournalPage } from './pages/PublicPages'
import { AudioTour, ChangelogPopup } from './components/AudioTour'
import { ChatFloatingButton } from './components/ChatFloatingButton'
// 2026-07-18 · redesign preview shell — full-viewport, isolated from main chrome
import DeskApp from './desk/DeskApp'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function Shell() {
  useLiveWebSocket()
  const { signals, indices, setIndices } = useStore()

  const indicesQuery = useQuery({
    queryKey: ['indices'], queryFn: () => api.indices(),
    staleTime: 60_000, refetchInterval: 60_000, refetchOnWindowFocus: false,
  })
  const healthQuery = useQuery({
    queryKey: ['health'], queryFn: () => api.health(),
    staleTime: 30_000, refetchInterval: 30_000, refetchOnWindowFocus: false,
  })
  const botQuery = useQuery({
    queryKey: ['bot-status'], queryFn: () => api.botStatus(),
    staleTime: 60_000, refetchInterval: 120_000, refetchOnWindowFocus: false,
  })
  if (indicesQuery.data && indicesQuery.data.indices !== indices) {
    setIndices(indicesQuery.data.indices)
  }
  const botRunning = botQuery.data?.running ?? false

  const counts = {
    all: signals.length,
    intraday: signals.filter(s => s.type === 'INTRADAY').length,
    options: signals.filter(s => s.type === 'OPTIONS').length,
    futures: signals.filter(s => s.type === 'FUTURES').length,
    swing: signals.filter(s => s.type === 'SWING').length,
    commodity: signals.filter(s => s.type === 'COMMODITY').length,
  }

  // 2026-05-07: PUBLIC_MODE flag. When true (Vercel build only), the app
  // exposes a 3-tab subset (Weekly / Options / Intraday) plus auth. All other
  // routes redirect to /weekly-pick. This is build-time gating — Vite tree-
  // shakes the unreached route components when behind the flag, so view-source
  // doesn't expose admin/internal pages on the public deploy.
  const PUBLIC_MODE = (import.meta as any).env?.VITE_PUBLIC_MODE === 'true'

  return (
    <div className="min-h-screen bg-ink-900 text-neutral-200">
      <Header botRunning={botRunning} health={healthQuery.data} />
      {!PUBLIC_MODE && <MarketBar indices={indices} />}
      <TabNav counts={counts} />
      <main className={PUBLIC_MODE
        ? "max-w-[1900px] mx-auto p-5"
        : "max-w-[1400px] mx-auto p-5 xl:pr-[320px]"}>
        {PUBLIC_MODE ? (
          <Routes>
            {/* Public deploy: 5 tabs OPEN to everyone (read-only, snapshot-fed).
                Auth pages (/login /signup /profile /admin/users) remain
                available for the weekend rollout but are NOT required to view
                tabs. The api/ backend stays in place — unused for now, will
                be re-gated when subscription plans launch. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
            <Route path="/admin/users" element={<RequireAuth adminOnly><AdminUsersPage /></RequireAuth>} />
            {/* 2026-05-30: /elite = best-of-best stream (all 5 confluences). */}
            <Route path="/elite"        element={<PublicEliteHub />} />
            <Route path="/fno-futures"  element={<PublicFnoFuturesPage />} />
            <Route path="/old-weekly"   element={<PublicOldWeeklyPickPage />} />
            <Route path="/sectors"      element={<PublicSectorRotationPage />} />
            <Route path="/confluence"   element={<PublicCrossConfluencePage />} />
            <Route path="/smart-money"  element={<PublicAdDivergencePage />} />
            <Route path="/pro-edge"     element={<PublicProEdgePage />} />
            {/* 2026-06-10: Options PRO merged into main F&O tab. Redirect for bookmarks. */}
            <Route path="/options-pro"  element={<Navigate to="/options" replace />} />
            <Route path="/sl-traps"     element={<PublicSlTrapPage />} />
            <Route path="/ask-ai"       element={<PublicChatPage />} />
            <Route path="/archive"      element={<PublicArchivePage />} />
            <Route path="/superstar"    element={<PublicSuperstarPicksPage />} />
            <Route path="/bulk-deals"   element={<PublicBulkDealsPage />} />
            <Route path="/early-momentum" element={<PublicEarlyMomentumPage />} />
            <Route path="/pedigree"     element={<PublicPedigreeAccumulationPage />} />
            <Route path="/elite-picks"  element={<PublicElitePicksPage />} />
            <Route path="/x-recs"       element={<PublicXRecsPage />} />
            <Route path="/chart-patterns" element={<PublicChartPatternsPage />} />
            <Route path="/insider-buys"  element={<PublicInsiderBuysPage />} />
            <Route path="/nifty-outlook" element={<PublicNiftyForesightPage />} />
            <Route path="/volume-profile" element={<PublicVolumeProfilePage />} />
            <Route path="/stock-fno-vp"   element={<PublicStockFnoVolumeProfilePage />} />
            <Route path="/oi-buildup"   element={<PublicOIBuildupPage />} />
            <Route path="/journal"      element={<PublicJournalPage />} />
            {/* 2026-05-29: 4-tab nav. /picks = unified hub for Top Trades /
                5-20% Move / Weekly / Daily (internal segment toggle). Old
                routes kept as bookmarkable backwards-compat redirects. */}
            <Route path="/picks"        element={<PublicPicksHub />} />
            <Route path="/pre-move"     element={<PublicPreMovePage />} />
            <Route path="/options"      element={<PublicOptionsPage />} />
            <Route path="/track-record" element={<PublicSignalsHistoryPage />} />
            {/* legacy deep links — still render the pages directly */}
            <Route path="/top-trades"   element={<PublicTopTradesPage />} />
            <Route path="/5-20-move"    element={<PublicPreMoveIdentifierPage />} />
            <Route path="/weekly-pick"  element={<PublicWeeklyPickPage />} />
            <Route path="/daily-pick"   element={<PublicDailyPickPage />} />
            <Route path="/intraday"     element={<PublicIntradayPage />} />
            <Route path="/" element={<Navigate to="/picks" replace />} />
            <Route path="*" element={<Navigate to="/picks" replace />} />
          </Routes>
        ) : (
        <Routes>
          {/* Auth (public) */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />

          {/* Top Trades — single curated unified feed (the "anti-noise" view) */}
          <Route path="/top-trades" element={<TopTradesPage />} />
          <Route path="/5-20-move" element={<PreMoveIdentifierPage />} />

          {/* Track Record — public signal history with outcomes (also on Vercel) */}
          <Route path="/track-record" element={<PublicSignalsHistoryPage />} />

          {/* Admin — users management (admin-only via RequireAuth) */}
          <Route path="/admin/users" element={<RequireAuth adminOnly><AdminUsersPage /></RequireAuth>} />

          {/* / is the multi-box dashboard (top 5 of each section + View more) */}
          <Route path="/" element={<DashboardHome />} />
          <Route path="/dashboard" element={<DashboardHome />} />
          {/* /preview — isolated light-theme dashboard for design review
              (see PreviewDashboard.tsx). Roll back = delete this line. */}
          <Route path="/preview" element={<PreviewDashboard />} />

          {/* Top-level tabs */}
          <Route path="/signals" element={<SignalsPage />} />
          <Route path="/intraday" element={<IntradayPage />} />
          <Route path="/gann" element={<GannCyclePage />} />
          <Route path="/timecycle" element={<TimeCyclePage />} />

          {/* Investment parent + sub-routes */}
          <Route path="/investment" element={<Navigate to="/investment/symbols" replace />} />
          <Route path="/investment/symbols" element={<SymbolsPage />} />
          <Route path="/investment/swings" element={<SwingPage />} />
          <Route path="/investment/fno" element={<OptionsPage />} />
          <Route path="/investment/daily-pick" element={<DailyPickPage />} />
          <Route path="/investment/weekly-pick" element={<WeeklyPickPage />} />
          <Route path="/investment/swing-scans" element={<SwingScanPage />} />
          <Route path="/investment/multibagger" element={<MultibaggerPage />} />
          <Route path="/investment/premove" element={<PreMovePage />} />
          <Route path="/investment/movers" element={<MoversPage />} />
          <Route path="/investment/pro" element={<ProScreenerPage />} />

          {/* Settings (in dropdown) */}
          <Route path="/commodity" element={<CommodityPage />} />
          <Route path="/backtest" element={<BacktestPage />} />
          <Route path="/backtest-results" element={<BacktestResultsPage />} />
          <Route path="/harmonic" element={<HarmonicPage />} />
          <Route path="/turtle-soup" element={<TurtleSoupPage />} />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/bot" element={<BotPage />} />

          {/* Options — first-class top-level route (same page as /investment/fno) */}
          <Route path="/options" element={<OptionsPage />} />

          {/* Legacy redirects for old bookmarks */}
          <Route path="/swing" element={<Navigate to="/investment/swings" replace />} />
          <Route path="/moneyflow" element={<Navigate to="/investment/symbols" replace />} />
          <Route path="/swingscan" element={<Navigate to="/investment/swing-scans" replace />} />
          <Route path="/multibagger" element={<Navigate to="/investment/multibagger" replace />} />
          <Route path="/premove" element={<Navigate to="/investment/premove" replace />} />
          <Route path="/movers" element={<Navigate to="/investment/movers" replace />} />
          <Route path="/pro" element={<Navigate to="/investment/pro" replace />} />
          <Route path="/daily" element={<Navigate to="/investment/daily-pick" replace />} />
          <Route path="/weekly" element={<Navigate to="/investment/weekly-pick" replace />} />
        </Routes>
        )}
      </main>
      {!PUBLIC_MODE && <LiveFeedSidebar />}
      {/* 2026-06-10: AudioTour (Hindi+English narration via Web Speech API)
          + one-time changelog popup. Both run only in PUBLIC_MODE. */}
      {PUBLIC_MODE && <AudioTour />}
      {PUBLIC_MODE && <ChangelogPopup />}
      {/* 2026-06-13: Floating 🤖 Ask AI button on every page (bottom-right,
          above the Tutorial button). Opens an inline chat panel — no
          navigation needed. Same backend as the /ask-ai tab. */}
      {PUBLIC_MODE && <ChatFloatingButton />}
      <Toaster
        position="top-right"
        toastOptions={{
          style: { background: '#111118', color: '#e0e0e0', border: '1px solid #1e1e2e' },
        }}
      />
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RootRouter />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/**
 * 2026-07-18 · RootRouter switches BEFORE the main Shell renders, so /desk/*
 * bypasses the header + sidebar + padding and takes the full viewport. This
 * keeps the redesign preview completely isolated — no chrome from the
 * existing app leaks into it and vice versa.
 */
function RootRouter() {
  return (
    <Routes>
      <Route path="/desk/*" element={<DeskApp />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  )
}
