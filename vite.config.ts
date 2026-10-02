import { defineConfig } from 'vite'
import { readFile } from 'node:fs/promises'
export default defineConfig({
  server: { port: 5173, strictPort: true },
  plugins: [{
    name: 'local-broker-connection',
    configureServer(server) {
      server.middlewares.use('/connection', async (req, res) => {
        const origin = req.headers.origin
        if (origin && origin !== 'http://127.0.0.1:5173') { res.statusCode = 403; res.end(); return }
        try {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(await readFile(new URL('./.runtime/connection.json', import.meta.url), 'utf8'))
        } catch { res.statusCode = 503; res.end('Start the local broker first.') }
      })
    },
  }],
})
