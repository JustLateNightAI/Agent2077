#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#   AGENT2077 — Full Installer
#   Usage: chmod +x install.sh && ./install.sh
#   Tested on Ubuntu 24.04 LTS Desktop
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
PINK="\033[1;35m"
RESET="\033[0m"

ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
info() { echo -e "  ${CYAN}→${RESET} $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
fail() { echo -e "  ${RED}✗${RESET} $*"; exit 1; }
hr()   { echo -e "${CYAN}──────────────────────────────────────────────────────${RESET}"; }

# ── Banner ─────────────────────────────────────────────────────────
clear
echo ""
echo -e "${BOLD}${CYAN}   ██████╗  ██████╗ ███████╗███╗   ██╗████████╗${PINK}██████╗  ██████╗ ███████╗███████╗${RESET}"
echo -e "${BOLD}${CYAN}  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝${PINK}╚════██╗██╔═████╗╚════██║╚════██║${RESET}"
echo -e "${BOLD}${CYAN}  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ${PINK} █████╔╝██║██╔██║    ██╔╝    ██╔╝${RESET}"
echo -e "${BOLD}${CYAN}  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ${PINK}██╔═══╝ ████╔╝██║   ██╔╝    ██╔╝ ${RESET}"
echo -e "${BOLD}${CYAN}  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ${PINK}███████╗╚██████╔╝   ██║     ██║  ${RESET}"
echo -e "${BOLD}${CYAN}  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝  ${PINK} ╚══════╝ ╚═════╝    ╚═╝     ╚═╝  ${RESET}"
echo -e "  ${BOLD}Full Installer — Ubuntu 24.04 LTS${RESET}"
echo ""
hr
echo ""

# ── Sanity checks ──────────────────────────────────────────────────
if [ -z "${BASH_VERSION:-}" ]; then
    echo "ERROR: Run this with bash, not sh.  →  bash install.sh"
    exit 1
fi

if [ "$EUID" -eq 0 ]; then
    fail "Don't run this script as root. Run as your normal user — it will ask for sudo when needed."
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "Install directory: $INSTALL_DIR"
echo ""

# ── Pre-flight: warm up sudo ───────────────────────────────────────
echo -e "${BOLD}This installer needs sudo for system-level setup (Docker, nginx, etc.).${RESET}"
echo "You may be asked for your password now and occasionally throughout."
echo ""
sudo -v || fail "sudo access required."
# Keep sudo alive in background for the duration of the install
( while true; do sudo -n true; sleep 50; done ) &
SUDO_KEEPALIVE_PID=$!
trap 'kill $SUDO_KEEPALIVE_PID 2>/dev/null; exit' EXIT INT TERM

echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 1 — System packages
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[1/10] System packages${RESET}"
hr
sudo apt-get update -y -qq
sudo apt-get install -y -qq \
    curl wget git build-essential g++ make python3 \
    ca-certificates gnupg lsb-release software-properties-common \
    avahi-daemon avahi-utils nginx sqlite3
ok "Core packages ready"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 2 — Node.js 22 via nvm
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[2/10] Node.js 22 (via nvm)${RESET}"
hr
export NVM_DIR="$HOME/.nvm"

if [ ! -d "$NVM_DIR" ]; then
    info "Installing nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# Source nvm into this session
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
else
    fail "nvm.sh not found at $NVM_DIR — install may have failed."
fi

type nvm &>/dev/null || fail "nvm function not available after sourcing."

nvm install 22 --no-progress
nvm use 22
nvm alias default 22

command -v node &>/dev/null || fail "'node' not found after nvm install."
command -v npm  &>/dev/null || fail "'npm'  not found after nvm install."

NODE_BIN="$(command -v node)"
ok "Node $(node -v) / npm $(npm -v)"
info "Node binary: $NODE_BIN"

# Persist nvm in .bashrc for future sessions
if ! grep -q 'NVM_DIR' "$HOME/.bashrc" 2>/dev/null; then
    {
        echo ""
        echo '# nvm — added by Agent2077 installer'
        echo 'export NVM_DIR="$HOME/.nvm"'
        echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
        echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'
    } >> "$HOME/.bashrc"
fi
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 3 — Docker
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[3/10] Docker${RESET}"
hr
if ! command -v docker &>/dev/null; then
    info "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    ok "Docker installed"
else
    ok "Docker already installed: $(docker --version)"
fi

if ! groups "$USER" | grep -q docker; then
    sudo usermod -aG docker "$USER"
    ok "Added $USER to docker group"
    warn "You'll need to log out and back in (or run 'newgrp docker') after this install for Docker to work without sudo."
else
    ok "$USER already in docker group"
fi

if ! sudo docker compose version &>/dev/null 2>&1; then
    sudo apt-get install -y -qq docker-compose-plugin
fi

sudo systemctl enable --now docker
ok "Docker service running"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 4 — Hostname & mDNS (agent2077.local)
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[4/10] Hostname & mDNS (agent2077.local)${RESET}"
hr
CURRENT_HOSTNAME="$(hostname)"
if [ "$CURRENT_HOSTNAME" != "Agent2077" ]; then
    info "Setting hostname from '$CURRENT_HOSTNAME' → 'Agent2077'..."
    sudo hostnamectl set-hostname Agent2077
    if ! grep -q "Agent2077" /etc/hosts; then
        echo "127.0.1.1 Agent2077 Agent2077.local" | sudo tee -a /etc/hosts > /dev/null
    fi
    ok "Hostname set to Agent2077"
else
    ok "Hostname already Agent2077"
fi

# devagent.local alias for the self-dev server
if ! grep -q "devagent" /etc/hosts 2>/dev/null; then
    echo "127.0.1.1 devagent devagent.local" | sudo tee -a /etc/hosts > /dev/null
    ok "devagent.local alias added"
fi

# Avahi service descriptor for self-dev server
sudo tee /etc/avahi/services/agent2077.service > /dev/null << 'AVAHIEOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Agent2077</name>
  <service>
    <type>_http._tcp</type>
    <port>80</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
AVAHIEOF

sudo systemctl enable --now avahi-daemon
sudo systemctl restart avahi-daemon
ok "agent2077.local resolvable on the LAN"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 5 — nginx reverse proxy
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[5/10] nginx reverse proxy${RESET}"
hr

# Create the nginx-apps directory inside the install dir.
# Agent2077 writes per-app server blocks here (no sudo needed — it's in its own dir).
# nginx reads from it via the include line below (read access only, world-readable).
NGINX_APPS_DIR="$INSTALL_DIR/nginx-apps"
mkdir -p "$NGINX_APPS_DIR"
chmod 755 "$NGINX_APPS_DIR"
ok "Created $NGINX_APPS_DIR for per-app nginx configs"

# Generate the nginx sites file dynamically so the include path is absolute
# and baked in — no group permissions or sudo needed at runtime.
sudo tee /etc/nginx/sites-available/agent2077 > /dev/null << NGINXEOF
# ── Production: Agent2077.local → port 5000 ──────────────────────────────
server {
    listen 80;
    server_name Agent2077.local agent2077.local localhost;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

# ── App Store apps: per-app nginx server blocks ─────────────────────────
#
# Agent2077 writes one server block per running app to:
#   $NGINX_APPS_DIR/agent2077-app-<port>.conf
#
# These files are owned by the Agent2077 user and written without sudo.
# nginx reads them here (read-only access is sufficient).
include $NGINX_APPS_DIR/agent2077-app-*.conf;

# ── Dev Server: devagent.local → port 5050 ────────────────────────────
server {
    listen 80;
    server_name devagent.local devagent;

    location / {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/agent2077 /etc/nginx/sites-enabled/agent2077
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t -q && sudo systemctl restart nginx && sudo systemctl enable nginx
ok "nginx configured and running"
ok "Per-app configs will be written to $NGINX_APPS_DIR (no sudo needed)"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 6 — SearXNG (Docker Compose)
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[6/10] SearXNG (search backend)${RESET}"
hr
cd "$INSTALL_DIR/docker"
sudo docker compose up -d
cd "$INSTALL_DIR"
ok "SearXNG running on port 8888"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 7 — npm install
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[7/10] Installing Node.js dependencies${RESET}"
hr
cd "$INSTALL_DIR"
npm install || fail "npm install failed — check output above."
ok "Dependencies installed"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 8 — Init database
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[8/10] Initialising database${RESET}"
hr
mkdir -p "$INSTALL_DIR/data"
npx tsx scripts/init-db.ts || fail "Database init failed — check output above."
ok "SQLite database initialised at data/agent2077.db"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 9 — Production build
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[9/10] Building production bundle${RESET}"
hr
npm run build || fail "Build failed — check output above."
ok "Production build complete → dist/"
echo ""

# ══════════════════════════════════════════════════════════════════
#  STEP 10 — systemd service
# ══════════════════════════════════════════════════════════════════
echo -e "${BOLD}[10/10] systemd service${RESET}"
hr

sudo tee /etc/systemd/system/agent2077.service > /dev/null << SERVICEEOF
[Unit]
Description=Agent2077 AI Agent Platform
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
Environment=PORT=5000
Environment=HOST=0.0.0.0
ExecStart=$NODE_BIN $INSTALL_DIR/dist/index.cjs
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable agent2077
ok "systemd service registered (agent2077.service)"
echo ""

# Kill the sudo keepalive — we're done with privileged steps
kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
trap - EXIT INT TERM

# ══════════════════════════════════════════════════════════════════
#  LAN / Network prompt
# ══════════════════════════════════════════════════════════════════
echo ""
hr
echo ""
echo -e "${BOLD}Network Access${RESET}"
echo ""
echo "  Agent2077 can serve on your local network so other devices"
echo "  (phone, laptop, etc.) can reach it at http://agent2077.local"
echo ""
echo -e "  ${YELLOW}If you select No, Agent2077 is only accessible on this machine.${RESET}"
echo ""

LISTEN_FLAG=""
LAN_SETTING="false"
while true; do
    read -r -p "  Serve Agent2077 on the local network? [y/N] " LAN_CHOICE
    case "${LAN_CHOICE,,}" in
        y|yes)
            LISTEN_FLAG="--listen"
            LAN_SETTING="true"
            ok "LAN mode enabled — Agent2077 will be reachable at http://agent2077.local"
            break
            ;;
        n|no|"")
            warn "LAN mode disabled — Agent2077 will only be accessible on this machine."
            break
            ;;
        *)
            echo "  Please enter y or n."
            ;;
    esac
done

# Persist the LAN choice into the Agent2077 settings database so the UI
# reflects the choice and future startups behave consistently.
DB_FILE="$INSTALL_DIR/data/agent2077.db"
if command -v sqlite3 &>/dev/null && [ -f "$DB_FILE" ]; then
    sqlite3 "$DB_FILE" "INSERT INTO settings(key, value, updated_at) VALUES('network.lanServing', '$LAN_SETTING', datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;"
    ok "LAN preference saved to database (network.lanServing=$LAN_SETTING)"
else
    warn "sqlite3 not found or DB not yet created — LAN preference not persisted to DB."
    warn "You can toggle it later in Agent2077 → Settings → Network."
fi
echo ""

# ══════════════════════════════════════════════════════════════════
#  Done — Summary
# ══════════════════════════════════════════════════════════════════
hr
echo ""
echo -e "${BOLD}${GREEN}  Installation complete!${RESET}"
echo ""
echo -e "${BOLD}  Quick reference${RESET}"
echo ""
echo "  Start (easy):         ./start.sh"
echo "  Start (manual):       NODE_ENV=production node dist/index.cjs $LISTEN_FLAG"
echo "  Start (service):      sudo systemctl start agent2077"
echo "  Stop  (service):      sudo systemctl stop agent2077"
echo "  Logs:                 journalctl -u agent2077 -f"
echo "  Dev mode:             npm run dev"
echo ""
echo "  Local URL:            http://localhost:5000"
if [ -n "$LISTEN_FLAG" ]; then
echo "  LAN URL:              http://agent2077.local"
fi
echo "  Default login:        Agent2077 / Agent2077"
echo ""
echo "  Services"
echo "    SearXNG (search):   http://localhost:8888"
echo "    nginx proxy:        port 80 → port 5000"
echo ""
if groups "$USER" | grep -q docker && ! id -nG "$USER" 2>/dev/null | grep -q www-data; then
    warn "Remember: log out and back in (or run 'newgrp docker && newgrp www-data')"
    warn "to activate docker and nginx group permissions without a full reboot."
    echo ""
fi
hr
echo ""

# ══════════════════════════════════════════════════════════════════
#  Launch
# ══════════════════════════════════════════════════════════════════
read -r -p "  Launch Agent2077 now? [Y/n] " LAUNCH_CHOICE
echo ""

case "${LAUNCH_CHOICE,,}" in
    n|no)
        echo "  You can start it any time with:"
        echo ""
        echo "    NODE_ENV=production node dist/index.cjs $LISTEN_FLAG"
        echo "    — or —"
        echo "    sudo systemctl start agent2077"
        echo ""
        ;;
    *)
        echo -e "  ${BOLD}Starting Agent2077...${RESET}"
        echo ""
        if [ -n "$LISTEN_FLAG" ]; then
            info "LAN mode on — access from any device at http://agent2077.local"
        else
            info "Local only — access at http://localhost:5000"
        fi
        echo ""
        echo "  Press Ctrl+C to stop."
        echo ""
        hr
        echo ""
        exec "$INSTALL_DIR/start.sh"
        ;;
esac
