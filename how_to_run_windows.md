# Running the Polymarket Bot on Windows

## Prerequisites

1. **Node.js** (v18 or newer)
   - Download from https://nodejs.org/
   - Choose the LTS version
   - The installer includes npm automatically
   - Verify after install: open PowerShell and run:
     ```
     node --version
     npm --version
     ```

2. **Git**
   - Download from https://git-scm.com/download/win
   - During install, choose "Git from the command line and also from 3rd-party software"

## Setup

Open PowerShell and run these commands:

```powershell
# 1. Clone the repo (or copy the folder from your Mac)
git clone <your-repo-url>
cd Polymarket-bot

# 2. Install dependencies
npm install

# 3. Build the dashboard
cd dashboard
npm install
npm run build
cd ..

# 4. Create your .env file
copy .env.example .env
```

## Configure .env

Open `.env` in Notepad (or any text editor) and set:

```
POLYMARKET_PRIVATE_KEY=your_private_key_here
CAPITAL_USD=50
DRY_RUN=true
DRY_RUN_RECORD=true
ARBITRAGE_ENABLED=false
DIPARB_ENABLED=false
SMARTMONEY_ENABLED=false
TREND_ANALYSIS_ENABLED=false
MM_ENABLED=true
LIVE_TRADING_CONFIRMED=false
```

## Run the Bot (Dry-Run)

```powershell
npx tsx bot-with-dashboard.ts
```

Dashboard opens at: **http://localhost:3001**

## Keep It Running Overnight

Windows may sleep and kill the process. To prevent this:

**Option A: Disable sleep**
1. Settings > System > Power & sleep
2. Set "Sleep" to **Never** (while plugged in)

**Option B: Use `caffeinate` equivalent**
```powershell
# Run in a separate PowerShell window to prevent sleep
powercfg -change -standby-timeout-ac 0
```
To restore later: `powercfg -change -standby-timeout-ac 30`

## Stop the Bot

Press `Ctrl+C` in the PowerShell window. The session is saved to history automatically.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npx tsx` not found | Run `npm install -g tsx` |
| Port 3001 already in use | Close other apps on that port, or kill it: `netstat -ano \| findstr :3001` then `taskkill /PID <pid> /F` |
| `node-gyp` errors during install | Install build tools: `npm install -g windows-build-tools` |
| EACCES / permission errors | Run PowerShell as Administrator |
| Dashboard won't load | Make sure you ran `npm run build` inside the `dashboard/` folder |
| WebSocket disconnects | Check Windows Firewall isn't blocking localhost connections |
