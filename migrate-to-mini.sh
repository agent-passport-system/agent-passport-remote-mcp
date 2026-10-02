#!/bin/bash
# ══════════════════════════════════════════════════════════
# MCP Remote Server Migration — Air → Mini
# Run on Mac Mini: bash migrate-to-mini.sh
# ══════════════════════════════════════════════════════════
set -e

echo "══════ Step 1: Clone + build ══════"
cd /Users/clawrot
if [ -d "agent-passport-remote-mcp" ]; then
  echo "Repo exists, pulling..."
  cd agent-passport-remote-mcp && git pull --rebase
else
  git clone https://github.com/agent-passport-system/agent-passport-remote-mcp.git
  cd agent-passport-remote-mcp
fi
npm install
npm run build
echo "✓ Built successfully"

echo ""
echo "══════ Step 2: Create cloudflared tunnel ══════"
TUNNEL_NAME="aeoess-mcp-remote"

# Check if tunnel already exists
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "Tunnel $TUNNEL_NAME already exists, reusing..."
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
else
  echo "Creating new tunnel..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
fi
echo "✓ Tunnel ID: $TUNNEL_ID"

echo ""
echo "══════ Step 3: Configure tunnel ══════"
CREDS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"

# Write tunnel config
cat > /Users/clawrot/agent-passport-remote-mcp/cloudflared-config.yml << EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDS_FILE}

ingress:
  - hostname: mcp.aeoess.com
    service: http://localhost:3002
  - service: http_status:404
EOF
echo "✓ Config written to cloudflared-config.yml"

echo ""
echo "══════ Step 4: Route DNS ══════"
cloudflared tunnel route dns "$TUNNEL_NAME" mcp.aeoess.com || echo "DNS route may already exist — check Cloudflare dashboard"
echo "✓ DNS routed"

echo ""
echo "══════ Step 5: Set up PM2 ══════"
# Write PM2 ecosystem config
cat > /Users/clawrot/agent-passport-remote-mcp/ecosystem.config.cjs << 'PMEOF'
module.exports = {
  apps: [
    {
      name: 'mcp-remote-server',
      script: './build/remote.js',
      cwd: '/Users/clawrot/agent-passport-remote-mcp',
      env: {
        NODE_ENV: 'production',
        PORT: '3002'
      },
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'mcp-tunnel',
      script: 'cloudflared',
      args: 'tunnel --config /Users/clawrot/agent-passport-remote-mcp/cloudflared-config.yml run',
      max_restarts: 10,
      restart_delay: 5000,
    }
  ]
}
PMEOF

# Start both
pm2 start /Users/clawrot/agent-passport-remote-mcp/ecosystem.config.cjs
pm2 save
echo "✓ PM2 started"

echo ""
echo "══════ Step 6: Verify ══════"
sleep 3
echo "Testing local..."
curl -s -m 5 -w "HTTP %{http_code}\n" http://localhost:3002/sse || echo "Local test failed"
echo ""
echo "Testing remote (may take 30s for DNS)..."
sleep 5
curl -s -m 10 -w "HTTP %{http_code}\n" https://mcp.aeoess.com/sse || echo "Remote not ready yet — DNS may need a minute"

echo ""
echo "══════════════════════════════════════════"
echo "✅ Migration complete!"
echo "══════════════════════════════════════════"
echo "Now stop the Air processes:"
echo "  On Air: pm2 stop agent-passport-mcp-remote"
echo "  On Air: pm2 stop cloudflared-tunnel"
echo "══════════════════════════════════════════"
