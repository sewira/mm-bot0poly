import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import {
  Header,
  BalanceCards,
  PnLPanel,
  ActivityLog,
  ConfigPanel,
  ConnectionStatus,
  QuickStats,
  SessionSummary,
  HistoryPage,
  PositionsPage,
} from './components';
import { MarketMakingPanel } from './components/MarketMakingPanel';

type Page = 'dashboard' | 'history' | 'positions';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const { state, config, logs, connected, error, sendCommand } = useWebSocket();
  const isDryRun = config?.dryRun ?? true;

  const handleClosePosition = (tokenId: string, size: number) => {
    sendCommand('closePosition', { tokenId, size });
  };

  const handleRedeemPosition = (conditionId: string) => {
    sendCommand('redeemPosition', { conditionId });
  };

  const handleToggleDryRun = () => {
    if (isDryRun) {
      const confirm = window.confirm(
        '⚠️ WARNING: You are switching to LIVE trading mode.\n\nReal funds will be used. Ensure you have loaded your Private Key and understand the risks.\n\nContinue?'
      );
      if (!confirm) return;
    }
    sendCommand('toggleDryRun', { enabled: !isDryRun });
  };

  // History page
  if (currentPage === 'history') {
    return <HistoryPage onBack={() => setCurrentPage('dashboard')} />;
  }

  // Positions page
  if (currentPage === 'positions') {
    return (
      <PositionsPage
        onBack={() => setCurrentPage('dashboard')}
        state={state}
        onClosePosition={handleClosePosition}
        onRedeemPosition={handleRedeemPosition}
      />
    );
  }

  // Main dashboard - Market Making focused
  return (
    <div className={`min-h-screen bg-poly-dark text-white ${isDryRun ? 'dry-run-breathing' : 'live-mode-breathing'}`}>
      {/* Mode Banner */}
      <div className={`${isDryRun ? 'bg-red-500/20 border-red-500/30' : 'bg-green-500/20 border-green-500/30'} border-b px-4 py-1.5 text-center`}>
        <span className={`${isDryRun ? 'text-red-400' : 'text-green-400'} font-medium text-xs flex items-center justify-center gap-2`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isDryRun ? 'bg-red-400' : 'bg-green-400'} animate-pulse`} />
          {isDryRun ? 'DRY RUN — No real trades' : 'LIVE — Real money trading'}
        </span>
      </div>

      {/* Connection Status */}
      <ConnectionStatus connected={connected} error={error} />

      {/* Header */}
      <Header
        state={state}
        config={config}
        connected={connected}
        onHistoryClick={() => setCurrentPage('history')}
        onPositionsClick={() => setCurrentPage('positions')}
        onToggleDryRun={handleToggleDryRun}
      />

      <main className="p-4 space-y-4 max-w-[1800px] mx-auto">
        {/* Row 1: Quick Stats + Balances */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <QuickStats state={state} config={config} />
          <BalanceCards state={state} />
        </div>

        {/* Row 2: Market Making Panel (full width) */}
        <MarketMakingPanel state={state} />

        {/* Row 3: PnL + Session Summary */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PnLPanel state={state} config={config} />
          <SessionSummary state={state} />
        </div>

        {/* Row 4: Activity Log */}
        <ActivityLog logs={logs} />

        {/* Config - Collapsible */}
        <details className="group">
          <summary className="cursor-pointer text-gray-500 text-sm hover:text-gray-400 flex items-center gap-2 py-2">
            <span className="transition-transform group-open:rotate-90">▶</span>
            Advanced Configuration
          </summary>
          <div className="mt-2">
            <ConfigPanel config={config} />
          </div>
        </details>
      </main>

      {/* Footer */}
      <footer className="text-center py-3 border-t border-white/5 text-gray-600 text-xs">
        <div className="flex flex-col gap-1">
          <div>Polymarket MM Bot v4.0 • {connected ? '🟢 Connected' : '🔴 Disconnected'}</div>
        </div>
      </footer>
    </div>
  );
}

export default App;
