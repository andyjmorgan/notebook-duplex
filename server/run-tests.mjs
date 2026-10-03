#!/usr/bin/env node
// Starts Postgres and SeaweedFS once, then runs every test file against them (node --test spawns a process per file).
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { testInfra } from './test-helpers.mjs'

const dir = fileURLToPath(new URL('./', import.meta.url))
const files = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(dir)).filter(f => f.endsWith('.test.mjs')).map(f => dir + f)
const infra = await testInfra()
const env = { ...process.env, TEST_DATABASE_URL: infra.databaseUrl, TEST_S3_ENDPOINT: infra.s3.endpoint, TEST_S3_ACCESS_KEY: infra.s3.accessKey, TEST_S3_SECRET_KEY: infra.s3.secretKey }
const child = spawn(process.execPath, ['--test', ...files], { env, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
