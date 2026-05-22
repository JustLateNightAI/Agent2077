#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#   AGENT2077 — Start Script
#   Usage: ./start.sh
#   Reads the network.lanServing setting from the database and starts
#   Agent2077 with or without LAN serving automatically.
# ═══════════════════════════════════════════════════════════════════

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_FILE="$INSTALL_DIR/data/agent2077.db"
DIST="$INSTALL_DIR/dist/index.cjs"

# ── Colour helpers ─────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
RESET="\033[0m"

# ── Sanity checks ──────────────────────────────────────────────────
if [ ! -f "$DIST" ]; then
    echo -e "${RED}✗${RESET} dist/index.cjs not found. Has Agent2077 been built?"
    echo "  Run the installer first:  ./install.sh"
    exit 1
fi

# ── Load nvm so 'node' is available ───────────────────────────────
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
fi

if ! command -v node &>/dev/null; then
    echo -e "${RED}✗${RESET} 'node' not found. Make sure Node.js is installed via nvm."
    exit 1
fi

# ── Read LAN setting from database ─────────────────────────────────
LAN_SERVING="false"
if command -v sqlite3 &>/dev/null && [ -f "$DB_FILE" ]; then
    LAN_SERVING="$(sqlite3 "$DB_FILE" "SELECT value FROM settings WHERE key='network.lanServing' LIMIT 1;" 2>/dev/null || echo "false")"
fi

# ── Banner ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}  AGENT2077${RESET}"
echo ""

if [ "$LAN_SERVING" = "true" ]; then
    echo -e "  ${GREEN}●${RESET} LAN serving ${BOLD}ON${RESET}  — accessible at ${CYAN}http://agent2077.local${RESET}"
    LISTEN_FLAG="--listen"
else
    echo -e "  ${YELLOW}●${RESET} LAN serving ${BOLD}OFF${RESET} — accessible at ${CYAN}http://localhost:5000${RESET} only"
    echo -e "    (Change this in Settings → Network, or re-run ./install.sh)"
    LISTEN_FLAG=""
fi

echo ""
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop."
echo ""
echo -e "${CYAN}──────────────────────────────────────────────────────${RESET}"
echo ""

# ── Launch (restart loop) ─────────────────────────────────────────
# Using a while loop instead of exec so the process restarts automatically
# when the promote/rollback flow writes the .restart-requested sentinel and
# server/index.ts calls process.exit(0).
export NODE_ENV=production
while true; do
    node "$DIST" $LISTEN_FLAG
    EXIT_CODE=$?
    # Exit code 0 = clean restart requested (sentinel). Anything else = crash.
    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${CYAN}  ↻  Restarting Agent2077...${RESET}"
        sleep 1
    else
        echo -e "${RED}  ✗  Agent2077 exited with code $EXIT_CODE.${RESET}"
        echo -e "    Restarting in 3 seconds... (Ctrl+C to abort)"
        sleep 3
    fi
done
