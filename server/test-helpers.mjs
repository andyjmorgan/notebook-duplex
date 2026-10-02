import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function until(predicate, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 40)) }
  throw new Error('Timed out waiting for expected state')
}
export async function startServer(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'notebook-duplex-test-'))
  const apiKey = 'test-key-' + Math.random().toString(36).slice(2)
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const child = spawn(process.execPath, [script], { env: { ...process.env, DATA_DIR: dataDir, PORT: '0', NOTEBOOK_API_KEY: apiKey, SESSION_GRACE_MS: '1500', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c)
  const url = await until(() => output.match(/listening on (http:\/\/[^ ]+)/)?.[1]).catch(e => { child.kill(); throw new Error(e.message + '\n' + output) })
  const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
  const request = async (path, data) => {
    const res = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST', headers, body: data === undefined ? undefined : JSON.stringify(data) })
    return { ok: res.ok, status: res.status, data: await res.json() }
  }
  t.after(async () => { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null); await rm(dataDir, { recursive: true, force: true }) })
  return { url, apiKey, headers, request, child, output: () => output, dataDir }
}
