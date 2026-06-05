#!/bin/bash
# Agent2077 Installer for Ubuntu 24.04 LTS Desktop
# Run: bash scripts/install.sh

# Ensure we're running in bash, not sh/dash
if [ -z "$BASH_VERSION" ]; then
    echo "ERROR: This script must be run with bash, not sh."
    echo "  Run: bash scripts/install.sh"
    exit 1
fi

echo "┌─────────────────────────────────────────┐"
echo "│       AGENT2077 — Installation Script     │"
echo "│       Ubuntu 24.04 LTS Desktop Setup      │"
echo "└─────────────────────────────────────────┘"
echo ""

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "[*] Install directory: $INSTALL_DIR"

# ── Version helpers ────────────────────────────────────────────────
# Minimum Node major version required by Agent2077: package.json engines.node
# if present, else .nvmrc, else 22.
required_node_major() {
    local req=""
    if command -v node &>/dev/null && [ -f "$INSTALL_DIR/package.json" ]; then
        req="$(node -e 'try{const e=require("./package.json").engines;if(e&&e.node){const m=String(e.node).match(/(\d+)/);if(m)process.stdout.write(m[1])}}catch(_){}' 2>/dev/null || true)"
    fi
    if [ -z "$req" ] && [ -f "$INSTALL_DIR/package.json" ]; then
        req="$(grep -A4 '"engines"' "$INSTALL_DIR/package.json" 2>/dev/null | grep -oE '"node"[^"]*"[^"]*"' | grep -oE '[0-9]+' | head -n1 || true)"
    fi
    if [ -z "$req" ] && [ -f "$INSTALL_DIR/.nvmrc" ]; then
        req="$(grep -oE '[0-9]+' "$INSTALL_DIR/.nvmrc" 2>/dev/null | head -n1 || true)"
    fi
    [ -z "$req" ] && req="22"
    echo "$req"
}

# Major version of the currently installed `node`, or empty if none.
current_node_major() {
    command -v node &>/dev/null || return 0
    node -v 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/'
}

# ── 1. System updates & essential packages ──────────────────────────
echo ""
echo "[1/10] Updating system and installing prerequisites..."
sudo apt update -y
sudo apt upgrade -y
sudo apt install -y \
    curl \
    wget \
    git \
    build-essential \
    g++ \
    make \
    python3 \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common
echo "  ✓ System packages installed"

# ── 2. Install Node.js via nvm ─────────────────────────────────────
NODE_REQUIRED_MAJOR="$(required_node_major)"
echo ""
echo "[2/10] Installing Node.js ${NODE_REQUIRED_MAJOR}+ ..."

# Report the status of any Node already on PATH.
EXISTING_NODE_MAJOR="$(current_node_major)"
if [ -n "$EXISTING_NODE_MAJOR" ]; then
    if [ "$EXISTING_NODE_MAJOR" -ge "$NODE_REQUIRED_MAJOR" ]; then
        echo "  ✓ Node $(node -v) detected — meets requirement (>= ${NODE_REQUIRED_MAJOR}.x)"
        [ "$EXISTING_NODE_MAJOR" -gt "$NODE_REQUIRED_MAJOR" ] && echo "    (newer than baseline Node ${NODE_REQUIRED_MAJOR} — that's fine)"
    else
        echo "  ⚠ Node $(node -v) is older than required (>= ${NODE_REQUIRED_MAJOR}.x) — will install Node ${NODE_REQUIRED_MAJOR} via nvm"
    fi
else
    echo "  → No Node.js on PATH — will install Node ${NODE_REQUIRED_MAJOR} via nvm"
fi

export NVM_DIR="$HOME/.nvm"

# Install nvm if not present
if [ ! -d "$NVM_DIR" ]; then
    echo "  Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    echo "  nvm installed to $NVM_DIR"
fi

# Source nvm — must happen AFTER the install above creates the files
# Using . (dot) instead of \. to avoid any escaping issues
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    echo "  nvm loaded successfully"
else
    echo "  ERROR: $NVM_DIR/nvm.sh not found after install!"
    echo "  Listing $NVM_DIR:"
    ls -la "$NVM_DIR/" 2>/dev/null || echo "  Directory does not exist"
    exit 1
fi

# Verify nvm is available as a function
if ! type nvm &>/dev/null; then
    echo "  ERROR: nvm function not available after sourcing!"
    exit 1
fi

# Install the baseline Node only if nvm doesn't already provide one that
# satisfies the requirement (avoids re-downloading when a newer Node exists).
NVM_BEST_MAJOR=""
if NVM_CUR="$(nvm version 2>/dev/null)" && [ "$NVM_CUR" != "N/A" ] && [ -n "$NVM_CUR" ]; then
    NVM_BEST_MAJOR="$(echo "$NVM_CUR" | sed -E 's/^v?([0-9]+).*/\1/')"
fi
if [ -n "$NVM_BEST_MAJOR" ] && [ "$NVM_BEST_MAJOR" -ge "$NODE_REQUIRED_MAJOR" ]; then
    echo "  ✓ nvm already provides Node v${NVM_BEST_MAJOR}.x (>= ${NODE_REQUIRED_MAJOR}.x) — using it"
    nvm use "$NVM_BEST_MAJOR" >/dev/null
else
    nvm install "$NODE_REQUIRED_MAJOR"
    nvm use "$NODE_REQUIRED_MAJOR"
    nvm alias default "$NODE_REQUIRED_MAJOR"
fi

# Verify node and npm work
if ! command -v node &>/dev/null; then
    echo "  ERROR: 'node' command not found after nvm install!"
    echo "  PATH: $PATH"
    exit 1
fi

if ! command -v npm &>/dev/null; then
    echo "  ERROR: 'npm' command not found after nvm install!"
    echo "  PATH: $PATH"
    exit 1
fi

NODE_VERSION="$(node -v)"
NPM_VERSION="$(npm -v)"
echo "  ✓ Node $NODE_VERSION / npm $NPM_VERSION installed"

# Store the absolute path to the node binary for systemd later
NODE_BIN="$(which node)"
echo "  Node binary: $NODE_BIN"

# Ensure nvm is sourced in .bashrc for future terminal sessions
if ! grep -q 'NVM_DIR' "$HOME/.bashrc" 2>/dev/null; then
    {
        echo ""
        echo '# nvm (added by Agent2077 installer)'
        echo 'export NVM_DIR="$HOME/.nvm"'
        echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
        echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"'
    } >> "$HOME/.bashrc"
fi

# ── 3. Install Docker ──────────────────────────────────────────────
echo ""
echo "[3/10] Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    echo "  ✓ Docker installed"
else
    echo "  ✓ Docker already installed: $(docker --version)"
fi

# Always ensure current user is in docker group (works for fresh install AND existing Docker)
if ! groups "$USER" | grep -q docker; then
    sudo usermod -aG docker "$USER"
    echo "  ✓ Added $USER to docker group (log out/in or run 'newgrp docker' to activate)"
else
    echo "  ✓ $USER already in docker group"
fi

# Ensure the Docker Compose v2 plugin is available (`docker compose`, not the
# legacy standalone `docker-compose`). Only install when genuinely missing.
if sudo docker compose version &>/dev/null; then
    echo "  ✓ Docker Compose v2 plugin already installed: $(sudo docker compose version --short 2>/dev/null || echo present)"
else
    if command -v docker-compose &>/dev/null; then
        echo "  ⚠ Found legacy 'docker-compose' ($(docker-compose --version 2>/dev/null | head -n1)); Agent2077 needs the Compose v2 plugin ('docker compose')."
    fi
    echo "  → Installing Docker Compose v2 plugin..."
    if sudo apt install -y docker-compose-plugin && sudo docker compose version &>/dev/null; then
        echo "  ✓ Docker Compose v2 plugin installed"
    else
        echo "  ✗ Could not install the Compose v2 plugin via apt."
        echo "    Install manually: sudo apt install docker-compose-plugin"
        echo "    or see https://docs.docker.com/compose/install/linux/"
        exit 1
    fi
fi

sudo systemctl enable docker
sudo systemctl start docker

# ── 4. Install Avahi (mDNS) ────────────────────────────────────────
echo ""
echo "[4/10] Setting up Agent2077.local (Avahi/mDNS)..."
sudo apt install -y avahi-daemon avahi-utils

CURRENT_HOSTNAME=$(hostname)
if [ "$CURRENT_HOSTNAME" != "Agent2077" ]; then
    echo "  Setting hostname to Agent2077..."
    sudo hostnamectl set-hostname Agent2077
    if ! grep -q "Agent2077" /etc/hosts; then
        echo "127.0.1.1 Agent2077 Agent2077.local" | sudo tee -a /etc/hosts > /dev/null
    fi
fi

# Add devagent.local for the self-dev server (port 5050)
if ! grep -q "devagent" /etc/hosts; then
    echo "127.0.1.1 devagent devagent.local" | sudo tee -a /etc/hosts > /dev/null
    echo "  ✓ devagent.local alias added"
fi

# Create Avahi service for dev server discovery
sudo tee /etc/avahi/services/devagent.service > /dev/null << 'AVAHIEOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Agent2077 Dev Server</name>
  <service>
    <type>_http._tcp</type>
    <port>5050</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
AVAHIEOF

sudo systemctl enable avahi-daemon
sudo systemctl restart avahi-daemon
echo "  ✓ Agent2077.local resolvable on the LAN"
echo "  ✓ devagent.local alias for dev server (port 5050)"

# ── 5. Install nginx ───────────────────────────────────────────────
echo ""
echo "[5/10] Installing nginx reverse proxy..."
sudo apt install -y nginx

sudo cp "$INSTALL_DIR/docker/nginx.conf" /etc/nginx/sites-available/agent2077
sudo ln -sf /etc/nginx/sites-available/agent2077 /etc/nginx/sites-enabled/agent2077
sudo rm -f /etc/nginx/sites-enabled/default

# Allow Agent2077 (runs as current user) to write per-app nginx configs
# without needing sudo each time. The conf.d dir is group-owned by www-data;
# we add the current user to that group instead of making conf.d world-writable.
AGENT_USER=$(whoami)
sudo chgrp www-data /etc/nginx/conf.d
sudo chmod g+w /etc/nginx/conf.d
sudo usermod -aG www-data "$AGENT_USER"
echo "  ✓ /etc/nginx/conf.d writable by $AGENT_USER (group: www-data)"
echo "    NOTE: You may need to log out and back in (or run 'newgrp www-data') for group to take effect."

sudo nginx -t && sudo systemctl restart nginx
sudo systemctl enable nginx
echo "  ✓ nginx configured and running"

# ── 6. Start support services (SearXNG) ────────────────────────────
echo ""
echo "[6/10] Starting support services (SearXNG)..."
cd "$INSTALL_DIR/docker"
sudo docker compose up -d
cd "$INSTALL_DIR"
echo "  ✓ SearXNG running on port 8888"

# ── 7. Install Node dependencies ───────────────────────────────────
echo ""
echo "[7/10] Installing Node.js dependencies..."
cd "$INSTALL_DIR"

# Verify node/npm still accessible (sudo commands above shouldn't break it, but be safe)
echo "  Using: $(which node) — $(node -v)"
echo "  Using: $(which npm) — npm $(npm -v)"

npm install

if [ $? -ne 0 ]; then
    echo "  ERROR: npm install failed!"
    exit 1
fi
echo "  ✓ Dependencies installed"

# ── 8. Initialize database ─────────────────────────────────────────
echo ""
echo "[8/10] Initializing SQLite database..."
mkdir -p "$INSTALL_DIR/data"
npx tsx scripts/init-db.ts

if [ $? -ne 0 ]; then
    echo "  ERROR: Database initialization failed!"
    exit 1
fi
echo "  ✓ Database initialized at data/agent2077.db"

# ── 9. Build production bundle ─────────────────────────────────────
echo ""
echo "[9/10] Building production bundle..."
npm run build

if [ $? -ne 0 ]; then
    echo "  ERROR: Production build failed!"
    exit 1
fi
echo "  ✓ Production build complete (dist/)"

# ── 10. Create systemd service ─────────────────────────────────────
echo ""
echo "[10/10] Creating systemd service..."

# Use the node binary path we captured earlier
echo "  Systemd will use: $NODE_BIN"

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
echo "  ✓ Systemd service created and enabled"

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "┌─────────────────────────────────────────┐"
echo "│       AGENT2077 — Installation Complete   │"
echo "└─────────────────────────────────────────┘"
echo ""
echo "  Access: http://Agent2077.local"
echo "  Login:  Agent2077 / Agent2077"
echo ""
echo "  Start now:"
echo "    sudo systemctl start agent2077"
echo ""
echo "  Development mode:"
echo "    cd $INSTALL_DIR && npm run dev"
echo ""
echo "  Services:"
echo "    SearXNG:     http://localhost:8888"
echo "    Agent2077:   http://localhost:5000 (direct)"
echo "    Agent2077:   http://Agent2077.local (via nginx)"
echo ""
echo "  View logs:"
echo "    journalctl -u agent2077 -f"
echo ""
echo "  NOTE: If this is your first Docker install, log out"
echo "        and back in so Docker works without sudo."
echo ""
