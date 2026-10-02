#!/usr/bin/env node
// Local stdio channel for Claude Code. Claude spawns this process; it proxies tools to the hosted
// Notebook Duplex server over MCP Streamable HTTP and forwards channel notifications back over stdio.
//
//   claude mcp add --transport stdio notebook-duplex -- node /path/to/agent/channel.mjs \
//     --url https://notebook.donkeywork.dev --key <notebook key>
//   claude --dangerously-load-development-channels server:notebook-duplex
import { basename } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const args = process.argv.slice(2)
const option = (name, env) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : process.env[env] }
const url = (option('--url', 'NOTEBOOK_DUPLEX_URL') ?? 'https://notebook.donkeywork.dev').replace(/\/$/, '')
const key = option('--key', 'NOTEBOOK_DUPLEX_KEY')
const name = option('--name', 'NOTEBOOK_DUPLEX_NAME') ?? basename(process.cwd())
if (!key) { console.error('notebook-duplex channel: pass --key <notebook key> or set NOTEBOOK_DUPLEX_KEY'); process.exit(2) }
const log = message => console.error('notebook-duplex channel: ' + message)

const channel = z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }).passthrough() })
let remote, remoteReady = Promise.resolve(), instructions = ''
const local = new Server({ name: 'notebook-duplex', version: '0.2.0' }, { capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } } })
let lastToolSignature = ''

async function connectRemote(attempt = 0) {
  const client = new Client({ name: 'notebook-duplex-channel', version: '0.2.0' }, { capabilities: {} })
  client.setNotificationHandler(channel, event => local.notification({ method: 'notifications/claude/channel', params: event.params }).catch(e => log('forward failed: ' + e.message)))
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + key } } })
  try {
    await client.connect(transport)
    instructions = client.getInstructions() ?? ''
    await client.callTool({ name: 'identify_session', arguments: { name, repo: process.cwd() } }).catch(() => {})
    remote = client
    log(`connected to ${url} as "${name}"`)
    // A redeploy can change the tool surface; tell Claude Code to re-list rather than keep a stale schema.
    try {
      const signature = JSON.stringify((await client.listTools()).tools)
      if (lastToolSignature && signature !== lastToolSignature) { await local.sendToolListChanged(); log('tool list changed; asked Claude Code to refresh') }
      lastToolSignature = signature
    } catch {}
    transport.onclose = () => { if (remote === client) { remote = undefined; log('remote closed, reconnecting'); remoteReady = connectRemote() } }
    transport.onerror = e => log('transport: ' + (e?.message ?? e))
  } catch (e) {
    remote = undefined
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
    log(`connect failed (${e.message}); retrying in ${delay / 1000}s`)
    await new Promise(r => setTimeout(r, delay))
    return connectRemote(attempt + 1)
  }
}
async function withRemote() { if (!remote) await remoteReady; if (!remote) throw new Error('Notebook Duplex is unreachable right now'); return remote }

local.setRequestHandler(ListToolsRequestSchema, async () => {
  const client = await withRemote()
  const { tools } = await client.listTools()
  return { tools: tools.filter(t => t.name !== 'identify_session') }
})
local.setRequestHandler(CallToolRequestSchema, async req => {
  try { const client = await withRemote(); return await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }) }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] } }
})

remoteReady = connectRemote()
await local.connect(new StdioServerTransport())
remoteReady.then(() => { if (instructions) log('ready') })
process.stdin.on('end', () => process.exit(0))
