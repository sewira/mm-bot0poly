# Reviewing Bot Performance

How to pull data from your VPS and review how the bot is performing.

## 1. Pull Logs from VPS to Local Machine

Run this from your **local machine** (Mac/Windows), not the VPS:

```bash
# Replace with your VPS IP and username
scp -r botuser@your-vps-ip:~/mm-bot0poly/logs/ ./logs-vps/
```

This copies the entire `logs/` folder from the VPS to a local `logs-vps/` directory.

### What's in the logs

| File | Contains |
|------|----------|
| `fills.jsonl` | Every fill: market, side, price, size, inventory, drift samples |
| `snapshots.jsonl` | Daily summary: markets quoted, fills, PnL, drift |
| `incidents.jsonl` | Circuit breaker fires, kill switch triggers, stale feed events |
| `journal.jsonl` | Parameter changes, decisions, review notes |
| `configs/*.json` | Frozen config snapshots (one per config change) |

## 2. Quick Health Check (SSH)

Without pulling files, you can check key stats directly:

```bash
# How many fills so far
ssh botuser@your-vps-ip "wc -l ~/mm-bot0poly/logs/fills.jsonl"

# Last 5 fills
ssh botuser@your-vps-ip "tail -5 ~/mm-bot0poly/logs/fills.jsonl"

# Check if snapshots are being written
ssh botuser@your-vps-ip "cat ~/mm-bot0poly/logs/snapshots.jsonl"

# Check for incidents (breaker fires, errors)
ssh botuser@your-vps-ip "wc -l ~/mm-bot0poly/logs/incidents.jsonl"

# Bot uptime and status
ssh botuser@your-vps-ip "pm2 status"

# Recent logs (last 30 lines)
ssh botuser@your-vps-ip "pm2 logs polybot --lines 30 --nostream"

# Error logs only
ssh botuser@your-vps-ip "pm2 logs polybot --err --lines 20 --nostream"
```

## 3. View Dashboard Remotely

### Via SSH Tunnel (recommended)

```bash
# From your local machine
ssh -L 3001:localhost:3001 botuser@your-vps-ip
```

Then open **http://localhost:3001** in your browser.

### What to look for on the dashboard

- **Status**: should say "quoting" (not "idle" or "stopped")
- **Total Fills**: should increase over time
- **Spread PnL**: net profit from market making
- **Markets table**: check which markets are active, their drift values
- **ROTATION logs**: in the activity log, look for "ROTATION: Removed/Added" messages

## 4. Run Review Agents (Weekly)

After pulling logs to your local machine, ask Claude Code to run the review agents:

```
run mm-reviewer, mm-grader, mm-strategist
```

This will:
- **mm-reviewer**: Write a journal entry, check for red metrics
- **mm-grader**: Compute fill rate, drift, PnL, and grade against gate thresholds
- **mm-strategist**: Evaluate whether to continue, adjust config, or stop

## 5. Key Metrics to Watch

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Fill rate | >5 fills/day | 1-5 fills/day | <1 fill/day |
| Drift (15s) | >= 0 bps | -5 to 0 bps | < -5 bps |
| Net PnL | Positive | Break-even | Negative |
| Markets active | 3-5 quoting | 1-2 quoting | 0 quoting |
| Incidents | 0 per day | 1-2 per day | >5 per day |

**Important:** These metrics are only meaningful after **100+ fills per market**. Before that, the numbers are noise.

## 6. Go-Live Decision Checklist

Before putting real money in, ALL of these must be true:

- [ ] At least 2 weeks of dry-run data
- [ ] >= 100 fills on at least 5 markets
- [ ] Fill-to-mark drift >= 0 (mean - 1×SE)
- [ ] Net edge positive (spread + rebate - drift > 0)
- [ ] No unresolved incidents
- [ ] Market rotation working (dead markets getting replaced)

If any gate fails, do NOT go live. Adjust or wait.

## 7. Common Scenarios

### Bot has 0 fills after 24h

```bash
# Check if quoting is active
ssh botuser@your-vps-ip "pm2 logs polybot --lines 10 --nostream"
```

Look for "Selected X market(s) for quoting". If 0 markets selected, the volume filter may be too strict — lower `minVolume24h` in `bot-with-dashboard.ts`.

### Bot keeps restarting

```bash
ssh botuser@your-vps-ip "pm2 logs polybot --err --lines 50 --nostream"
```

Check the error logs for crash reasons. Common causes: API rate limits, network issues, out of memory.

### Dashboard not loading

```bash
# Check if bot is running
ssh botuser@your-vps-ip "pm2 status"

# Check if port 3001 is listening
ssh botuser@your-vps-ip "netstat -tlnp | grep 3001"
```

### Want to see market rotation in action

```bash
ssh botuser@your-vps-ip "pm2 logs polybot --lines 200 --nostream" | grep ROTATION
```
