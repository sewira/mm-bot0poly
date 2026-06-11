import type { BotState } from '../types';

interface MarketMakingPanelProps {
  state: BotState | null;
}

export function MarketMakingPanel({ state }: MarketMakingPanelProps) {
  const mm = state?.marketMaking;
  const status = mm?.status ?? 'idle';
  const markets = mm?.markets ?? [];
  const totalFills = mm?.totalFills ?? 0;
  const totalRequotes = mm?.totalRequotes ?? 0;
  const spreadPnL = mm?.realizedSpreadPnL ?? 0;
  const rebateIncome = mm?.modeledRebateIncome ?? 0;
  const grossExposure = mm?.grossExposureUsd ?? 0;

  const statusColors: Record<string, string> = {
    quoting: 'text-green-400 bg-green-500/20 border-green-500/30',
    scanning: 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30',
    idle: 'text-gray-400 bg-gray-500/20 border-gray-500/30',
    stopped: 'text-red-400 bg-red-500/20 border-red-500/30',
  };

  const activeMarkets = markets.filter(m => !m.isBlacklisted).length;

  return (
    <div className="glass-card rounded-2xl p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-lg">
            MM
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Market Making</h2>
            <p className="text-xs text-gray-500">Active markets & positions</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`px-3 py-1 rounded-full text-xs font-medium border ${statusColors[status] || statusColors.idle}`}>
            {status.toUpperCase()}
          </span>
          <div className="text-right">
            <div className="text-xs text-gray-500">Markets</div>
            <div className="text-sm font-mono font-bold text-white">{activeMarkets}/{markets.length}</div>
          </div>
        </div>
      </div>

      {/* Summary Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-500">Fills</div>
          <div className="text-lg font-mono font-bold text-white">{totalFills}</div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-500">Requotes</div>
          <div className="text-lg font-mono font-bold text-white">{totalRequotes}</div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-500">Spread PnL</div>
          <div className={`text-lg font-mono font-bold ${spreadPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${spreadPnL.toFixed(2)}
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-500">Rebate (est)</div>
          <div className="text-lg font-mono font-bold text-blue-400">
            ${rebateIncome.toFixed(2)}
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-500">Gross Exp.</div>
          <div className="text-lg font-mono font-bold text-yellow-400">
            ${grossExposure.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Markets Table */}
      {markets.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs uppercase border-b border-white/10">
                <th className="text-left py-2 px-2">Market</th>
                <th className="text-right py-2 px-2">Mid</th>
                <th className="text-right py-2 px-2">Bid</th>
                <th className="text-right py-2 px-2">Ask</th>
                <th className="text-right py-2 px-2">Inventory</th>
                <th className="text-right py-2 px-2">Drift (bps)</th>
                <th className="text-center py-2 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market, i) => (
                <tr key={i} className={`border-b border-white/5 ${market.isBlacklisted ? 'opacity-40' : ''}`}>
                  <td className="py-2 px-2 text-white font-medium max-w-[200px] truncate">
                    {market.name}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-gray-300">
                    {market.mid.toFixed(3)}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-green-400">
                    {market.bidPrice > 0 ? market.bidPrice.toFixed(3) : '-'}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-red-400">
                    {market.askPrice > 0 ? market.askPrice.toFixed(3) : '-'}
                  </td>
                  <td className={`py-2 px-2 text-right font-mono ${market.inventory > 0 ? 'text-green-400' : market.inventory < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                    {market.inventory > 0 ? '+' : ''}{market.inventory}
                  </td>
                  <td className={`py-2 px-2 text-right font-mono ${market.rollingDriftBps >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {market.rollingDriftBps >= 0 ? '+' : ''}{market.rollingDriftBps.toFixed(1)}
                  </td>
                  <td className="py-2 px-2 text-center">
                    {market.isBlacklisted ? (
                      <span className="text-xs text-red-400">BLOCKED</span>
                    ) : (
                      <span className="text-xs text-green-400">ACTIVE</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">
          <div className="text-2xl mb-2">📊</div>
          <p>No markets active yet</p>
          <p className="text-xs mt-1">Markets will appear once the MM service starts quoting</p>
        </div>
      )}
    </div>
  );
}
