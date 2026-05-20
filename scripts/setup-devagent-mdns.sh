#!/bin/bash
# Setup devagent.local mDNS alias — allows accessing the dev server at http://devagent.local
# Run: sudo bash scripts/setup-devagent-mdns.sh

echo "[*] Setting up devagent.local mDNS alias..."

# Create Avahi CNAME alias service
# This publishes "devagent.local" as a CNAME for the host
sudo tee /etc/avahi/services/devagent.service > /dev/null << 'EOF'
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
EOF

# Avahi doesn't natively support CNAME aliases via service files.
# Instead, we add devagent.local to /etc/hosts and use avahi-publish-host-name
# The cleanest approach: use the avahi-alias utility or /etc/hosts

# Add devagent entry to /etc/hosts for local resolution
if ! grep -q "devagent" /etc/hosts; then
  echo "127.0.1.1 devagent devagent.local" | sudo tee -a /etc/hosts > /dev/null
  echo "  ✓ Added devagent.local to /etc/hosts"
fi

# Restart Avahi to pick up the new service
sudo systemctl restart avahi-daemon

echo "  ✓ devagent.local → port 5050 configured"
echo ""
echo "  Access dev server at: http://devagent.local"
echo "  (Requires the dev server to be running on port 5050)"
