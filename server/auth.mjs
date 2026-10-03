import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Identity: Keycloak access tokens for the browser, personal access tokens (ndp_…) for agents, or a dev user that bypasses both.
export const TOKEN_PREFIX = 'ndp_'
export const hashToken = token => createHash('sha256').update(token).digest('hex')

export class Auth {
  constructor(db, { issuer, jwksUrl, clientId, devUser } = {}) {
    this.db = db; this.issuer = issuer; this.clientId = clientId; this.devUser = devUser || null
    if (this.devUser && process.env.NODE_ENV === 'production') throw new Error('AUTH_DEV_USER must not be set in production')
    if (!this.devUser && (!issuer || !jwksUrl || !clientId)) throw new Error('Set OIDC_ISSUER, OIDC_JWKS_URL and OIDC_CLIENT_ID, or AUTH_DEV_USER for local development')
    if (jwksUrl) this.jwks = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30000, cacheMaxAge: 600000 })
    this.touched = new Map()
  }
  async start() { if (this.devUser) this.dev = this.describe(await this.db.upsertUser({ sub: 'dev:' + this.devUser, email: this.devUser, name: this.devUser.split('@')[0] }), 'dev') }
  describe(u, via) { return { sub: u.sub, email: u.email ?? null, name: u.name ?? u.email ?? u.sub, via } }

  // Returns the user for a request or null. mcpOnly restricts to agent tokens (the MCP endpoint).
  async authenticate(req, { mcpOnly = false } = {}) {
    if (this.dev) return this.dev
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return null
    if (token.startsWith(TOKEN_PREFIX)) return this.fromToken(token)
    if (mcpOnly) return null
    return this.fromJwt(token)
  }
  async fromToken(token) {
    const found = await this.db.tokenByHash(hashToken(token))
    if (!found) return null
    const last = this.touched.get(found.id) ?? 0
    if (Date.now() - last > 60000) { this.touched.set(found.id, Date.now()); this.db.touchToken(found.id).catch(() => {}) }
    return this.describe(found, 'token')
  }
  async fromJwt(token) {
    let payload
    try { ({ payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer })) } catch { return null }
    const audience = [].concat(payload.aud ?? [])
    if (payload.azp !== this.clientId && !audience.includes(this.clientId)) return null
    const user = await this.db.upsertUser({ sub: payload.sub, email: payload.email ?? null, name: payload.name ?? payload.preferred_username ?? payload.email ?? null })
    return this.describe(user, 'oidc')
  }
  async mintToken(sub, name) {
    const token = TOKEN_PREFIX + randomBytes(30).toString('base64url').slice(0, 40)
    const created = await this.db.createToken({ sub, name, hash: hashToken(token), prefix: token.slice(0, 10) })
    return { id: created.id, name: created.name, prefix: created.prefix, createdAt: created.createdAt, token }
  }
}
export const authFromEnv = (db, env = process.env) => new Auth(db, { issuer: env.OIDC_ISSUER, jwksUrl: env.OIDC_JWKS_URL, clientId: env.OIDC_CLIENT_ID, devUser: env.AUTH_DEV_USER })
