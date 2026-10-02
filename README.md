# Agent Passport System: Remote MCP Server

[![Glama Badge](https://glama.ai/mcp/servers/@aeoess/agent-passport-system-mcp/badge)](https://glama.ai/mcp/servers/@aeoess/agent-passport-system-mcp)

Remote MCP server for the [Agent Passport System](https://aeoess.com): cryptographic identity, scoped delegation, policy enforcement, and governance for AI agents.

**Hosted endpoint:** `https://mcp.aeoess.com/sse` is temporarily restricted while the hosted deployment is being updated. Anonymous connections return HTTP 401. Self-hosting is unaffected.

## Connect

The hosted endpoint is not currently available for anonymous MCP connections. Connection instructions will be restored after the hosted deployment update.

For local or self-hosted use, see Self-Hosting below.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `GET /sse` | SSE transport for MCP clients |
| `POST /message?sessionId=...` | Send messages to MCP session |
| `GET /health` | Health check (JSON) |
| `GET /.well-known/agent.json` | A2A Agent Card |

## 152 MCP Tools

All protocol modules exposed across identity, delegation, policy evaluation, values floor, commerce, reputation, coordination, context, comms, Agora, attribution, and institutional governance. The full tool surface tracks the upstream SDK and MCP server: see [agent-passport-system](https://www.npmjs.com/package/agent-passport-system) and [agent-passport-system-mcp](https://www.npmjs.com/package/agent-passport-system-mcp) for the authoritative list.

## Self-Hosting

```bash
git clone https://github.com/agent-passport-system/agent-passport-remote-mcp.git
cd agent-passport-remote-mcp
npm install && npm run build
npm start
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `API_KEY` | (none) | Optional auth key |
| `MAX_SESSIONS` | `100` | Max concurrent MCP sessions |
| `SESSION_TIMEOUT` | `3600000` | Session timeout (ms) |

## Links

- **Website:** [aeoess.com](https://aeoess.com)
- **npm SDK:** [agent-passport-system](https://www.npmjs.com/package/agent-passport-system) (the current version is whatever the registry shows)
- **npm MCP:** [agent-passport-system-mcp](https://www.npmjs.com/package/agent-passport-system-mcp) (v6.0.0, 152 tools)
- **Paper:** [The Agent Social Contract](https://doi.org/10.5281/zenodo.18749779)
- **GitHub:** [aeoess](https://github.com/aeoess)

## License

Apache-2.0
