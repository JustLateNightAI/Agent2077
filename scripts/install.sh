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

# ── 2. Install Node.js 22 via nvm ──────────────────────────────────
echo ""
echo "[2/10] Installing Node.js 22..."

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

# Install Node 22
nvm install 22
nvm use 22
nvm alias default 22

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

# Ensure Docker Compose plugin is available
if ! sudo docker compose version &>/dev/null 2>&1; then
    sudo apt install -y docker-compose-plugin
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
