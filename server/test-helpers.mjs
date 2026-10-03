import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

export async function until(predicate, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const result = await predicate(); if (result) return result; await new Promise(r => setTimeout(r, 40)) }
  throw new Error('Timed out waiting for expected state')
}

// Real Postgres and SeaweedFS for the tests. TEST_DATABASE_URL and TEST_S3_ENDPOINT point at existing services;
// otherwise Docker containers start once per process on random host ports and are removed when the process exits.
let infraPromise
export function testInfra() { return infraPromise ??= startInfra() }
async function startInfra() {
  const infra = { databaseUrl: process.env.TEST_DATABASE_URL, s3: { endpoint: process.env.TEST_S3_ENDPOINT, accessKey: process.env.TEST_S3_ACCESS_KEY ?? 'test', secretKey: process.env.TEST_S3_SECRET_KEY ?? 'test', region: 'us-east-1' }, containers: [] }
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  const hostPort = (id, port) => Number(docker('port', id, port).split('\n')[0].split(':').pop())
  if (!infra.databaseUrl) {
    const id = docker('run', '-d', '--rm', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_PASSWORD=test', 'pgvector/pgvector:pg17', '-c', 'fsync=off', '-c', 'synchronous_commit=off')
    infra.containers.push(id)
    infra.databaseUrl = `postgres://test:test@127.0.0.1:${hostPort(id, 5432)}/postgres`
  }
  if (!infra.s3.endpoint) {
    const id = docker('run', '-d', '--rm', '-p', '127.0.0.1::8333', 'chrislusf/seaweedfs:3.71', 'server', '-s3', '-dir=/data', '-ip.bind=0.0.0.0', '-master.volumeSizeLimitMB=64', '-volume.max=0')
    infra.containers.push(id)
    infra.s3.endpoint = `http://127.0.0.1:${hostPort(id, 8333)}`
  }
  if (infra.containers.length) process.on('exit', () => { try { execFileSync('docker', ['rm', '-f', ...infra.containers], { stdio: 'ignore' }) } catch {} })
  await until(async () => { const c = new pg.Client({ connectionString: infra.databaseUrl }); try { await c.connect(); await c.query('select 1'); return true } catch { return false } finally { await c.end().catch(() => {}) } }, 60000)
  const s3 = new S3Client({ endpoint: infra.s3.endpoint, region: infra.s3.region, forcePathStyle: true, credentials: { accessKeyId: infra.s3.accessKey, secretAccessKey: infra.s3.secretKey } })
  await until(async () => {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: 'readiness' })).catch(e => { if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e })
      await s3.send(new PutObjectCommand({ Bucket: 'readiness', Key: 'ping', Body: 'pong' }))
      return (await (await s3.send(new GetObjectCommand({ Bucket: 'readiness', Key: 'ping' }))).Body.transformToString()) === 'pong'
    } catch { return false }
  }, 60000)
  return infra
}
// A fresh database and bucket name per server so tests never see each other's documents.
export async function freshBackend() {
  const infra = await testInfra()
  const name = 't' + Math.random().toString(36).slice(2, 10)
  const admin = new pg.Client({ connectionString: infra.databaseUrl })
  await admin.connect(); await admin.query(`create database ${name}`); await admin.end()
  return { databaseUrl: infra.databaseUrl.replace(/\/[^/]*$/, '/' + name), bucket: name, s3: infra.s3 }
}

export async function startServer(t, env = {}, { backend, seed } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'notebook-duplex-test-'))
  backend ??= await freshBackend()
  if (seed) await seed(dataDir)
  const script = fileURLToPath(new URL('./index.mjs', import.meta.url))
  const serverEnv = { ...process.env, DATA_DIR: dataDir, PORT: '0', SESSION_GRACE_MS: '1500', AUTH_DEV_USER: 'dev@example.com', DATABASE_URL: backend.databaseUrl, S3_ENDPOINT: backend.s3.endpoint, S3_BUCKET: backend.bucket, S3_ACCESS_KEY: backend.s3.accessKey, S3_SECRET_KEY: backend.s3.secretKey, S3_REGION: backend.s3.region, ...env }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete serverEnv[key]
  const child = spawn(process.execPath, [script], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c)
  const url = await until(() => output.match(/listening on (http:\/\/[^ ]+)/)?.[1] || (child.exitCode !== null && 'exited'), 30000).catch(e => { child.kill(); throw new Error(e.message + '\n' + output) })
  if (url === 'exited') throw new Error('server exited during startup\n' + output)
  const apiKey = env.AUTH_DEV_USER === undefined && 'AUTH_DEV_USER' in env ? '' : 'dev'
  const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
  const request = async (path, data, method) => {
    const res = await fetch(url + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers, body: data === undefined ? undefined : JSON.stringify(data) })
    const text = await res.text()
    let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
    return { ok: res.ok, status: res.status, data: parsed, headers: res.headers }
  }
  // Creates a document and returns request helpers scoped to its editing routes.
  const createDocument = async (fields = {}) => {
    const { data, ok } = await request('/api/documents', { title: 'Test document', ...fields })
    if (!ok) throw new Error('create failed: ' + JSON.stringify(data))
    return { ...data, doc: (path, body, method) => request(`/api/d/${data.id}/${path}`, body, method) }
  }
  t.after(async () => { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 10000); await rm(dataDir, { recursive: true, force: true }) })
  return { url, apiKey, headers, request, createDocument, child, output: () => output, dataDir, backend }
}
