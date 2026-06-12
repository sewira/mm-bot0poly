# Running the Polymarket Bot on a VPS

## Recommended VPS Specs

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 1 GB | 2 GB |
| CPU | 1 vCPU | 2 vCPU |
| Storage | 10 GB | 20 GB |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 LTS |

Cheap options: DigitalOcean ($6/mo), Hetzner ($4/mo), Vultr ($6/mo), AWS Lightsail ($5/mo).

The bot is lightweight — 1 GB RAM is enough for dry-run. If running live with many markets, 2 GB is safer.

## 1. Connect to Your VPS

```bash
ssh root@your-vps-ip
```

## 2. Install Node.js

```bash
# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version
npm --version
```

## 3. Install Git & Build Tools

```bash
sudo apt-get update
sudo apt-get install -y git build-essential
```

## 4. Install Cloudflare WARP VPN (If Needed)

If your VPS is in a geo-restricted region, install WARP to route traffic through Cloudflare:

```bash
# Add Cloudflare GPG key
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg

# Add repo
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list

# Install
sudo apt-get update
sudo apt-get install -y cloudflare-warp

# Register (one-time)
warp-cli registration new

# Connect
warp-cli connect

# Verify — should show Cloudflare IP, not your VPS IP
curl ifconfig.me
```

### WARP Commands

```bash
warp-cli status       # Check connection status
warp-cli connect      # Connect
warp-cli disconnect   # Disconnect
warp-cli settings     # View settings
```

### Make WARP Auto-Start on Boot

WARP runs as a systemd service and auto-starts by default. Verify:

```bash
sudo systemctl status warp-svc
sudo systemctl enable warp-svc
```

### If WARP Breaks SSH Access

WARP can sometimes route SSH traffic through the tunnel, locking you out. To prevent this, exclude your SSH connection before connecting:

```bash
# Run BEFORE warp-cli connect
warp-cli add-excluded-route your-local-ip/32
```

If you get locked out, most VPS providers have a web console (browser-based terminal) in their dashboard. Use it to run `warp-cli disconnect`.

## 5. Create a Non-Root User (Recommended)

```bash
adduser botuser
usermod -aG sudo botuser
su - botuser
```

## 6. Clone and Setup

```bash
git clone <your-repo-url>
cd Polymarket-bot

# Install dependencies
npm install

# Build dashboard
cd dashboard
npm install
npm run build
cd ..

# Create .env
cp .env.example .env
nano .env
```

## 7. Configure .env

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

Save with `Ctrl+X`, then `Y`, then `Enter`.

## 8. Run with PM2 (Process Manager)

PM2 keeps the bot running 24/7, restarts on crash, and auto-starts on reboot.

```bash
# Install PM2
sudo npm install -g pm2 tsx

# Start the bot
pm2 start bot-with-dashboard.ts --interpreter tsx --name polybot

# Check status
pm2 status
pm2 logs polybot

# Auto-restart on server reboot
pm2 startup
pm2 save
```

### PM2 Commands

```bash
pm2 logs polybot          # Live logs
pm2 logs polybot --lines 100  # Last 100 lines
pm2 stop polybot          # Stop
pm2 restart polybot       # Restart
pm2 delete polybot        # Remove
pm2 monit                 # CPU/RAM monitor
```

## 9. Access the Dashboard Remotely

The dashboard runs on port 3001. Two options:

### Option A: SSH Tunnel (Simple, Secure)

From your local machine:
```bash
ssh -L 3001:localhost:3001 botuser@your-vps-ip
```
Then open **http://localhost:3001** in your browser.

### Option B: Open Port with Firewall (Less Secure)

```bash
# Allow port 3001
sudo ufw allow 3001

# Access from browser
# http://your-vps-ip:3001
```

**Warning:** This exposes the dashboard to the internet with no authentication. Only use for dry-run testing. For live trading, use SSH tunnel (Option A) or set up a reverse proxy with authentication.

### Option C: Nginx Reverse Proxy with Basic Auth

```bash
# Install nginx and apache2-utils (for htpasswd)
sudo apt-get install -y nginx apache2-utils

# Create password file
sudo htpasswd -c /etc/nginx/.htpasswd botuser

# Create nginx config
sudo nano /etc/nginx/sites-available/polybot
```

Paste this config:
```nginx
server {
    listen 80;
    server_name your-vps-ip;

    location / {
        auth_basic "Bot Dashboard";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/polybot /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo ufw allow 80
```

Access at **http://your-vps-ip** with your username/password.

## 10. Updating the Bot

```bash
cd ~/Polymarket-bot
git pull
npm install
cd dashboard && npm install && npm run build && cd ..
pm2 restart polybot
```

## 11. Check Session History After Restart

Session data persists in `data/session-history.json`. After PM2 restarts the bot (crash or manual), previous sessions are saved and visible in the History page.

Recording data persists in `logs/fills.jsonl` and `logs/book-snapshots.jsonl`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `pm2: command not found` | `sudo npm install -g pm2` |
| Bot crashes immediately | Check logs: `pm2 logs polybot --lines 50` |
| Dashboard not loading remotely | Check firewall: `sudo ufw status`, ensure port is open or tunnel is active |
| Out of memory | Check with `free -h`. Upgrade VPS or add swap: `sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
| WebSocket disconnects on nginx | Make sure the `Upgrade` and `Connection` headers are in the nginx config |
| `tsx` not found by PM2 | Install globally: `sudo npm install -g tsx` |
| Bot not auto-starting on reboot | Run `pm2 startup` and follow the printed command, then `pm2 save` |
| WARP won't connect | Check service: `sudo systemctl restart warp-svc`, then `warp-cli connect` |
| Locked out of SSH after WARP | Use VPS provider's web console to run `warp-cli disconnect` |
| Bot can't reach Polymarket APIs | Check WARP status: `warp-cli status`. If disconnected, run `warp-cli connect` |
