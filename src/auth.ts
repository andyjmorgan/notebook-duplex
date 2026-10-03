// Identity. Keycloak over OpenID Connect (Authorization Code + PKCE) through oidc-client-ts, loaded lazily.
// When the server runs with AUTH_DEV_USER it reports `devUser` in /api/config and we skip OIDC entirely.
import type { User, UserManager } from 'oidc-client-ts'

export type AuthConfig = { authority?: string; clientId?: string; build?: string; devUser?: string }
export type AuthUser = { sub: string; name: string; email: string }
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'error'
export const CALLBACK_PATH = '/auth/callback'
const RETURN_KEY = 'notebook-duplex.returnTo'

type Listener = () => void
class Auth {
  status: AuthStatus = 'loading'
  user: AuthUser | undefined
  config: AuthConfig = {}
  error = ''
  dev = false
  private um: UserManager | undefined
  private listeners = new Set<Listener>()
  private flushers = new Set<() => Promise<void>>()
  private recovering: Promise<boolean> | undefined
  private started: Promise<void> | undefined

  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  private emit() { for (const l of this.listeners) l() }
  private set(status: AuthStatus, user?: AuthUser) { this.status = status; this.user = user; this.emit() }
  /** Register work to finish (pending saves) before the browser leaves for the identity provider. */
  beforeLeave(fn: () => Promise<void>) { this.flushers.add(fn); return () => { this.flushers.delete(fn) } }
  private async flushAll() { await Promise.allSettled([...this.flushers].map(f => f().catch(() => {}))) }

  start() { return this.started ??= this.init().catch(e => { this.error = (e as Error).message; this.set('error') }) }
  private async init() {
    const res = await fetch('/api/config', { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`The server did not answer /api/config (${res.status}).`)
    this.config = await res.json()
    if (this.config.devUser) {
      this.dev = true
      const email = this.config.devUser
      this.set('signed-in', { sub: 'dev:' + email, name: email.split('@')[0] || 'Developer', email })
      return
    }
    if (!this.config.authority || !this.config.clientId) throw new Error('The server is missing its OIDC configuration.')
    const { UserManager, WebStorageStateStore, Log } = await import('oidc-client-ts')
    Log.setLogger(console); Log.setLevel(Log.WARN)
    const origin = location.origin
    this.um = new UserManager({
      authority: this.config.authority, client_id: this.config.clientId,
      redirect_uri: origin + CALLBACK_PATH, post_logout_redirect_uri: origin + '/',
      response_type: 'code', scope: 'openid profile email',
      automaticSilentRenew: true, accessTokenExpiringNotificationTimeInSeconds: 60,
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      stateStore: new WebStorageStateStore({ store: window.localStorage }),
      monitorSession: false, loadUserInfo: false, includeIdTokenInSilentRenew: false,
    })
    this.um.events.addUserLoaded(u => this.set('signed-in', toUser(u)))
    this.um.events.addUserUnloaded(() => this.set('signed-out'))
    this.um.events.addUserSignedOut(() => void this.leave('You were signed out.'))
    this.um.events.addSilentRenewError(() => void this.leave('Your session could not be renewed.'))
    this.um.events.addAccessTokenExpired(() => void this.recover().then(ok => { if (!ok) void this.leave('Your session expired.') }))

    if (location.pathname === CALLBACK_PATH) {
      try {
        const user = await this.um.signinCallback()
        const returnTo = (user?.state as string | undefined) || sessionStorage.getItem(RETURN_KEY) || '/'
        sessionStorage.removeItem(RETURN_KEY)
        history.replaceState(null, '', returnTo.startsWith('/') && !returnTo.startsWith(CALLBACK_PATH) ? returnTo : '/')
        if (user) { this.set('signed-in', toUser(user)); return }
      } catch (e) {
        history.replaceState(null, '', '/')
        throw new Error('Sign-in did not complete: ' + (e as Error).message)
      }
    }
    const existing = await this.um.getUser()
    if (existing && !existing.expired) { this.set('signed-in', toUser(existing)); return }
    if (existing?.refresh_token && await this.recover()) return
    this.set('signed-out')
  }

  /** Bearer token for API calls; undefined in dev mode (no header is sent). */
  async token(): Promise<string | undefined> {
    if (this.dev || !this.um) return undefined
    const u = await this.um.getUser()
    return u?.access_token
  }
  /** One silent renew at a time; callers retry their request when it resolves true. */
  recover(): Promise<boolean> {
    if (this.dev || !this.um) return Promise.resolve(false)
    return this.recovering ??= this.um.signinSilent().then(u => { if (u) this.set('signed-in', toUser(u)); return Boolean(u) }).catch(() => false).finally(() => { this.recovering = undefined })
  }
  async signIn(returnTo = location.pathname + location.search) {
    if (!this.um) return
    await this.flushAll()
    try { sessionStorage.setItem(RETURN_KEY, returnTo) } catch {}
    await this.um.signinRedirect({ state: returnTo })
  }
  /** Session lost: save what we can, then go back through sign-in without losing the writer's place. */
  private async leave(reason: string) {
    this.error = reason
    await this.flushAll()
    this.set('signed-out')
    await this.signIn()
  }
  async signOut() {
    await this.flushAll()
    if (this.dev || !this.um) { location.assign('/'); return }
    await this.um.signoutRedirect()
  }
}
const toUser = (u: User): AuthUser => ({ sub: u.profile.sub, name: (u.profile.name as string) || (u.profile.preferred_username as string) || (u.profile.email as string) || 'You', email: (u.profile.email as string) || '' })
export const auth = new Auth()

export function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
