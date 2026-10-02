/**
 * Agent Passport System — Remote MCP Server
 * Bridges the stdio MCP server to SSE + HTTP transports.
 * Deploy at mcp.aeoess.com for one-URL access from any MCP client.
 */

import express from 'express'
import cors from 'cors'
import { randomUUID, createHash, timingSafeEqual } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { HANDSHAKE_ID, clientRequestId, isClientResponse } from './mcp-correlate.js'

const PORT = parseInt(process.env.PORT || '3001')
const HOST = process.env.HOST || '0.0.0.0'
const API_KEY = process.env.API_KEY || ''
const MCP_COMMAND = process.env.MCP_COMMAND || 'node'
const MCP_ARGS = (process.env.MCP_ARGS || 'node_modules/agent-passport-system-mcp/build/bin.js').split(' ')
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT || '3600000')
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '100')
const GATEWAY_URL = process.env.AEOESS_GATEWAY_URL || process.env.GATEWAY_URL || 'https://gateway.aeoess.com'
const GATEWAY_API_KEY = process.env.AEOESS_GATEWAY_KEY || process.env.GATEWAY_API_KEY || ''

interface Session {
  id: string
  process: ChildProcess
  sseResponse: express.Response | null
  created: number
  lastActivity: number
  pendingPassportIds: Set<number | string>  // JSON-RPC IDs for issue_passport calls
}

const sessions = new Map<string, Session>()

// Unique identifier for this MCP server process lifetime. Reset on every
// Railway deploy. Gateway deduplicates snapshots per session_id.
const MCP_SESSION_ID = randomUUID()
const MCP_SERVER_VERSION = '2.25.0'
const MCP_STARTED_AT = Date.now()

// ═══════════════════════════════════════
// Persistent Usage Stats
// ═══════════════════════════════════════
const STATS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'stats.json')

interface PersistentStats {
  totalSessions: number
  totalToolCalls: number
  totalStatelessRequests: number
  firstSeen: string
  lastSeen: string
  dailySessions: Record<string, number>  // YYYY-MM-DD → count
  toolCalls: Record<string, number>      // tool_name → count
  passportsIssued: number                // identity-related tool calls
}

function loadStats(): PersistentStats {
  try {
    if (existsSync(STATS_FILE)) {
      const loaded = JSON.parse(readFileSync(STATS_FILE, 'utf-8'))
      // Migrate: add new fields if missing
      if (!loaded.toolCalls) loaded.toolCalls = {}
      if (!loaded.passportsIssued) loaded.passportsIssued = 0
      return loaded
    }
  } catch {}
  return { totalSessions: 0, totalToolCalls: 0, totalStatelessRequests: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), dailySessions: {}, toolCalls: {}, passportsIssued: 0 }
}

function saveStats() {
  try { writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)) } catch {}
}

const stats = loadStats()

function recordSession() {
  stats.totalSessions++
  stats.lastSeen = new Date().toISOString()
  const day = new Date().toISOString().slice(0, 10)
  stats.dailySessions[day] = (stats.dailySessions[day] || 0) + 1
  saveStats()
}

function recordToolCall() {
  stats.totalToolCalls++
  stats.lastSeen = new Date().toISOString()
  saveStats()
}

// Identity tools that count as "passport issued"
const PASSPORT_TOOLS = new Set([
  'issue_passport', 'generate_keys', 'identify', 'create_principal',
  'endorse_agent', 'join_social_contract',
])

function recordToolName(body: any) {
  try {
    // JSON-RPC tools/call: { method: "tools/call", params: { name: "generate_keys" } }
    if (body?.method === 'tools/call' && body?.params?.name) {
      const toolName = body.params.name
      stats.toolCalls[toolName] = (stats.toolCalls[toolName] || 0) + 1
      if (PASSPORT_TOOLS.has(toolName)) {
        stats.passportsIssued++
      }
      saveStats()
    }
  } catch {}
}

function recordStatelessRequest() {
  stats.totalStatelessRequests++
  stats.lastSeen = new Date().toISOString()
  saveStats()
}

// ═══════════════════════════════════════
// Gateway Bridge — Register agents on passport issuance
// Best-effort, fire-and-forget. Never blocks passport delivery.
// ═══════════════════════════════════════

async function registerAgentWithGateway(mcpResponse: any) {
  if (!GATEWAY_API_KEY) return
  try {
    const content = mcpResponse?.result?.content
    if (!content || !Array.isArray(content)) return
    const textBlock = content.find((c: any) => c.type === 'text')
    if (!textBlock?.text) return

    const data = JSON.parse(textBlock.text)
    const agentId = data.agentId || data.did || `mcp-agent-${Date.now()}`
    const publicKey = data.publicKey || ''
    const name = data.passport?.passport?.name || data.passport?.passport?.agentId || 'MCP Agent'

    const resp = await fetch(`${GATEWAY_URL}/api/v1/agents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GATEWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent_id: agentId, public_key: publicKey, name }),
      signal: AbortSignal.timeout(5000),
    })
    console.log(`[gateway] Registered agent ${agentId} (status: ${resp.status})`)
  } catch (err: any) {
    console.log(`[gateway] Registration failed (best-effort): ${err.message}`)
  }
}

// ═══════════════════════════════════════
// Gateway Stats Sync — periodic heartbeat + SIGTERM flush
// Persists counters across Railway restarts.
// Fire-and-forget: never blocks or throws.
// ═══════════════════════════════════════

async function syncStatsToGateway(reason: 'heartbeat' | 'shutdown' = 'heartbeat') {
  if (!GATEWAY_API_KEY) return
  try {
    const payload = {
      session_id: MCP_SESSION_ID,
      uptime_seconds: Math.floor((Date.now() - MCP_STARTED_AT) / 1000),
      passports_issued: stats.passportsIssued,
      sessions_total: stats.totalSessions,
      sessions_active: sessions.size,
      tool_calls_total: stats.totalToolCalls,
      version: MCP_SERVER_VERSION,
    }
    const resp = await fetch(`${GATEWAY_URL}/api/v1/mcp-stats`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GATEWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
    console.log(`[stats-sync:${reason}] gateway status ${resp.status}`)
  } catch (err: any) {
    console.log(`[stats-sync:${reason}] failed (best-effort): ${err.message}`)
  }
}

// 5-minute heartbeat
setInterval(() => { syncStatsToGateway('heartbeat').catch(() => {}) }, 5 * 60 * 1000)
// Initial sync after 30s so new deploys are visible quickly
setTimeout(() => { syncStatsToGateway('heartbeat').catch(() => {}) }, 30 * 1000)

// ═══════════════════════════════════════
// Cumulative stats cache — /stats fetches gateway totals once per 60s
// ═══════════════════════════════════════
let cumulativeCache: { data: any; expires: number } | null = null
async function getCumulativeStats() {
  if (cumulativeCache && cumulativeCache.expires > Date.now()) return cumulativeCache.data
  try {
    const resp = await fetch(`${GATEWAY_URL}/api/v1/mcp-stats/cumulative`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    cumulativeCache = { data, expires: Date.now() + 60_000 }
    return data
  } catch {
    return null
  }
}

function cleanupSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (session) {
    try { session.process.kill('SIGTERM') } catch {}
    try { session.sseResponse?.end() } catch {}
    sessions.delete(sessionId)
    console.log(`[${sessionId.slice(0, 8)}] Session cleaned up (${sessions.size} active)`)
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`[${id.slice(0, 8)}] Session timed out`)
      cleanupSession(id)
    }
  }
}, 60000)

// Compare digests so the comparison takes the same time whatever the input length or contents.
function apiKeyMatches(presented: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(API_KEY).digest()
  return timingSafeEqual(a, b)
}

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!API_KEY) return next()
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }
  if (!apiKeyMatches(authHeader.slice(7))) {
    res.status(403).json({ error: 'Invalid API key' })
    return
  }
  next()
}

function spawnMCPProcess(sessionId: string): ChildProcess {
  const child = spawn(MCP_COMMAND, MCP_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', MCP_TRANSPORT: 'sse', MCP_REMOTE: '1' }
  })
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`)
  })
  child.on('exit', (code) => {
    console.log(`[${sessionId.slice(0, 8)}] MCP process exited with code ${code}`)
    cleanupSession(sessionId)
  })
  child.on('error', (err) => {
    console.error(`[${sessionId.slice(0, 8)}] MCP process error: ${err.message}`)
    cleanupSession(sessionId)
  })
  return child
}

const app = express()
app.use(cors({ origin: true, credentials: true, exposedHeaders: ['X-Session-Id'] }))
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'agent-passport-remote-mcp', version: MCP_SERVER_VERSION, sessions: sessions.size, maxSessions: MAX_SESSIONS, uptime: process.uptime() })
})

// /stats is public. Without the gateway API key it returns only a pointer to the public
// metrics page (aeoess.com/gateway.html), the server version and uptime. With the key it
// returns the full usage stats.
app.get('/stats', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!GATEWAY_API_KEY || !authHeader || authHeader !== `Bearer ${GATEWAY_API_KEY}`) {
    return res.json({
      message: 'Public metrics available at https://aeoess.com/gateway.html',
      status: 'ok',
      version: MCP_SERVER_VERSION,
      uptime: process.uptime(),
    })
  }
  const today = new Date().toISOString().slice(0, 10)
  const topTools = Object.entries(stats.toolCalls)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }))
  const cumulative = await getCumulativeStats()
  res.json({
    ...stats,
    activeSessions: sessions.size,
    todaySessions: stats.dailySessions[today] || 0,
    uptimeHours: Math.round(process.uptime() / 3600 * 10) / 10,
    topTools,
    cumulative,
    sessionId: MCP_SESSION_ID,
  })
})

app.get('/.well-known/agent.json', (_req, res) => {
  res.json({
    name: 'Agent Passport System', description: 'Cryptographic identity, delegation, policy enforcement, and governance for AI agents. 152 tools across the full governance distribution stack.',
    url: 'https://mcp.aeoess.com', version: MCP_SERVER_VERSION,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: [
      { id: 'identity', name: 'Agent Identity', description: 'Ed25519 cryptographic passports' },
      { id: 'delegation', name: 'Scoped Delegation', description: 'Delegation chains with cascade revocation' },
      { id: 'policy', name: 'Policy Engine', description: '3-signature chain: intent, evaluation, receipt' },
      { id: 'coordination', name: 'Task Coordination', description: 'Full task lifecycle with evidence and review' },
      { id: 'commerce', name: 'Agentic Commerce', description: '4-gate checkout with human approval gates' },
      { id: 'compliance', name: 'EU AI Act', description: 'Risk classification and compliance reporting' }
    ],
    documentation: 'https://aeoess.com/llms-full.txt'
  })
})

// SSE Transport: GET /sse — establish connection, spawn MCP subprocess
app.get('/sse', authMiddleware, (req, res) => {
  if (sessions.size >= MAX_SESSIONS) { res.status(503).json({ error: 'Max sessions reached' }); return }
  const sessionId = randomUUID()
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Session-Id', sessionId)
  res.flushHeaders()

  const child = spawnMCPProcess(sessionId)
  const session: Session = { id: sessionId, process: child, sseResponse: res, created: Date.now(), lastActivity: Date.now(), pendingPassportIds: new Set() }
  sessions.set(sessionId, session)
  recordSession()
  console.log(`[${sessionId.slice(0, 8)}] SSE session started (${sessions.size} active, ${stats.totalSessions} lifetime)`)

  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('host') || 'mcp.aeoess.com'
  const baseUrl = process.env.PUBLIC_URL || `${proto}://${host}`
  const messageUrl = `${baseUrl}/message?sessionId=${sessionId}`
  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`)

  // Heartbeat to keep SSE alive through Railway/Fastly CDN proxy
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`) }
    catch { clearInterval(heartbeat) }
  }, 15000)

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (line.trim()) {
      try {
        const parsed = JSON.parse(line)
        session.lastActivity = Date.now()
        res.write(`event: message\ndata: ${line}\n\n`)
        // Gateway bridge: register agent when issue_passport response arrives
        if (parsed.id != null && session.pendingPassportIds.has(parsed.id)) {
          session.pendingPassportIds.delete(parsed.id)
          registerAgentWithGateway(parsed).catch(() => {})
        }
      }
      catch { /* non-JSON stdout, skip */ }
    }
  })
  child.on('exit', (code) => {
    console.log(`[${sessionId.slice(0, 8)}] Child process exited (code ${code}) — cleaning up`)
    clearInterval(heartbeat)
    cleanupSession(sessionId)
  })
  req.on('close', () => { console.log(`[${sessionId.slice(0, 8)}] Client disconnected`); clearInterval(heartbeat); cleanupSession(sessionId) })
})

// POST /message — client sends JSON-RPC to MCP subprocess
app.post('/message', authMiddleware, (req, res) => {
  const sessionId = req.query.sessionId as string
  if (!sessionId) { res.status(400).json({ error: 'Missing sessionId' }); return }
  const session = sessions.get(sessionId)
  if (!session) { res.status(404).json({ error: 'Session not found or expired' }); return }
  session.lastActivity = Date.now()
  try {
    session.process.stdin!.write(JSON.stringify(req.body) + '\n')
    recordToolCall()
    recordToolName(req.body)
    // Track issue_passport calls for gateway bridge
    if (req.body?.method === 'tools/call' && req.body?.params?.name === 'issue_passport' && req.body?.id != null) {
      session.pendingPassportIds.add(req.body.id)
    }
    res.status(202).json({ status: 'accepted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message to MCP server' })
  }
})

// Streamable HTTP: POST /mcp — stateless request-response
app.post('/mcp', authMiddleware, async (req, res) => {
  recordStatelessRequest()
  const child = spawn(MCP_COMMAND, MCP_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', MCP_TRANSPORT: 'sse', MCP_REMOTE: '1' } })
  let responded = false
  const clientId = clientRequestId(req.body)
  const timeout = setTimeout(() => { if (!responded) { responded = true; try { child.kill() } catch {}; res.status(504).json({ error: 'MCP timeout' }) } }, 30000)

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    if (!line.trim() || responded) return
    let parsed: any
    try { parsed = JSON.parse(line) } catch { return /* skip non-JSON */ }
    // Only forward the response that correlates to the client's own request.
    // Skip the injected initialize handshake echo and any server notifications
    // so the client receives its actual result, not the serverInfo echo.
    if (!isClientResponse(parsed, clientId)) return
    responded = true; clearTimeout(timeout); res.json(parsed); setTimeout(() => { try { child.kill() } catch {} }, 100)
  })
  child.on('error', (err) => { if (!responded) { responded = true; clearTimeout(timeout); res.status(500).json({ error: err.message }) } })
  child.on('exit', (code) => { if (!responded) { responded = true; clearTimeout(timeout); res.status(500).json({ error: `Process exited ${code}` }) } })

  const initMessage = JSON.stringify({ jsonrpc: '2.0', id: HANDSHAKE_ID, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-mcp-bridge', version: '1.0.0' } } })
  try {
    child.stdin!.write(initMessage + '\n')
    setTimeout(() => { try { recordToolName(req.body); child.stdin!.write(JSON.stringify({ ...req.body, id: clientId }) + '\n') } catch {} }, 100)
  } catch (err) { if (!responded) { responded = true; clearTimeout(timeout); res.status(500).json({ error: `Write failed: ${err}` }) } }
})

// Landing page
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(`<!DOCTYPE html><html><head><title>Agent Passport — Remote MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#0a0e1a;color:#e0e0e0}
h1{color:#60a5fa}code{background:#1e293b;padding:2px 8px;border-radius:4px;font-size:.9em}
pre{background:#1e293b;padding:16px;border-radius:8px;overflow-x:auto;border-left:3px solid #60a5fa}
a{color:#60a5fa}.badge{display:inline-block;background:#166534;color:#bbf7d0;padding:2px 10px;border-radius:12px;font-size:.85em}</style></head>
<body><h1>Agent Passport System</h1><p><span class="badge">v${MCP_SERVER_VERSION} — 152 tools</span></p>
<p>Remote MCP server for cryptographic agent identity, delegation, policy enforcement, and governance. 67 core + 32 v2 constitutional modules.</p>
<h2>Connect</h2><p><b>SSE:</b> <code>https://mcp.aeoess.com/sse</code></p>
<h3>Claude Desktop</h3><pre>{ "mcpServers": { "agent-passport": { "type": "sse", "url": "https://mcp.aeoess.com/sse" } } }</pre>
<h2>Links</h2><ul><li><a href="https://aeoess.com">Website</a></li><li><a href="https://www.npmjs.com/package/agent-passport-system">npm SDK</a></li>
<li><a href="https://github.com/aeoess">GitHub</a></li><li><a href="/health">Health Check</a></li>
<li><a href="/stats">Usage Stats</a></li>
<li><a href="/.well-known/agent.json">A2A Agent Card</a></li></ul></body></html>`)
})

app.listen(PORT, HOST, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`)
  console.log(`║  Agent Passport System — Remote MCP Server       ║`)
  console.log(`║  ${HOST}:${PORT}                                         ║`)
  console.log(`║  Auth: ${API_KEY ? 'API key required' : 'open (no auth)'}                           ║`)
  console.log(`╚══════════════════════════════════════════════════╝\n`)
  console.log(`Endpoints:`)
  console.log(`  GET  /        Landing page`)
  console.log(`  GET  /sse     SSE transport`)
  console.log(`  POST /message SSE message endpoint`)
  console.log(`  POST /mcp     Streamable HTTP`)
  console.log(`  GET  /health  Health check`)
  console.log(`  GET  /stats   Usage statistics`)
  console.log(`  GET  /.well-known/agent.json  A2A Agent Card\n`)
})

process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await syncStatsToGateway('shutdown').catch(() => {})
  for (const [id] of sessions) cleanupSession(id)
  process.exit(0)
})
process.on('SIGINT', async () => {
  console.log('Interrupted...')
  await syncStatsToGateway('shutdown').catch(() => {})
  for (const [id] of sessions) cleanupSession(id)
  process.exit(0)
})
