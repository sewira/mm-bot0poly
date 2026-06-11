import type { BotState, BotConfig } from '../types';

interface QuickStatsProps {
  state: BotState | null;
  config: BotConfig | null;
}

export function QuickStats({ state }: QuickStatsProps) {
  const mm = state?.marketMaking;
  const spreadPnL = mm?.realizedSpreadPnL ?? 0;
  const rebateIncome = mm?.modeledRebateIncome ?? 0;
  const netPnL = spreadPnL + rebateIncome;
  const totalFills = mm?.totalFills ?? 0;
  const activeMarkets = mm?.markets?.filter(m => !m.isBlacklisted).length ?? 0;

  // Average drift across active markets
  const activeMarketsData = mm?.markets?.filter(m => !m.isBlacklisted) ?? [];
  const avgDrift = activeMarketsData.length > 0
    ? activeMarketsData.reduce((sum, m) => sum + m.rollingDriftBps, 0) / activeMarketsData.length
    : 0;

  const formatPnL = (value: number) => {
    const formatted = Math.abs(value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return value >= 0 ? `+$${formatted}` : `-$${formatted}`;
  };

  return (
    <div className="glass-card rounded-2xl p-1">
      <div className="flex items-center justify-between gap-2 px-2">
        {/* Net PnL */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`icon-circle-sm ${netPnL >= 0 ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
            {netPnL >= 0 ? '📈' : '📉'}
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Net PnL</div>
            <div className={`text-lg font-bold font-mono ${netPnL >= 0 ? 'text-green-400 glow-text-green' : 'text-red-400 glow-text-red'}`}>
              {formatPnL(netPnL)}
            </div>
          </div>
        </div>

        <div className="w-px h-10 bg-white/10" />

        {/* Spread PnL */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`icon-circle-sm ${spreadPnL >= 0 ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
            📊
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Spread</div>
            <div className={`text-lg font-bold font-mono ${spreadPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {formatPnL(spreadPnL)}
            </div>
          </div>
        </div>

        <div className="w-px h-10 bg-white/10" />

        {/* Rebate */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="icon-circle-sm bg-blue-500/20">💎</div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Rebate</div>
            <div className="text-lg font-bold font-mono text-blue-400">
              {formatPnL(rebateIncome)}
            </div>
          </div>
        </div>

        <div className="w-px h-10 bg-white/10" />

        {/* Total Fills */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="icon-circle-sm bg-purple-500/20">💹</div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Fills</div>
            <div className="text-lg font-bold font-mono text-purple-400">{totalFills}</div>
          </div>
        </div>

        <div className="w-px h-10 bg-white/10" />

        {/* Avg Drift */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`icon-circle-sm ${avgDrift >= 0 ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
            🎯
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Drift</div>
            <div className={`text-lg font-bold font-mono ${avgDrift >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {avgDrift >= 0 ? '+' : ''}{avgDrift.toFixed(1)} bps
            </div>
          </div>
        </div>

        <div className="w-px h-10 bg-white/10" />

        {/* Active Markets */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="icon-circle-sm bg-yellow-500/20">⚡</div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Markets</div>
            <div className="text-lg font-bold font-mono text-yellow-400">
              {activeMarkets}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
