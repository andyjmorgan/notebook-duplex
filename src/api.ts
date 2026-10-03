import { auth } from './auth'

export class Unauthorized extends Error { constructor() { super('Your session has ended. Sign in again to continue.') } }
export let lastBuild = ''
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
type Options = { method?: Method; body?: unknown; accept?: 'json' | 'blob' }

async function send(path: string, { method = 'GET', body, accept = 'json' }: Options, retried = false): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept === 'json' ? 'application/json' : '*/*' }
  const token = await auth.token()
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const build = response.headers.get('x-build'); if (build) lastBuild = build
  if (response.status === 401) {
    // One silent renew, then retry; if that fails the writer goes back through sign-in with their place kept.
    if (!retried && await auth.recover()) return send(path, { method, body, accept }, true)
    if (!auth.dev) void auth.signIn()
    throw new Unauthorized()
  }
  return response
}
async function fail(response: Response): Promise<never> {
  const result = await response.json().catch(() => ({}))
  throw new Error(result.error ?? `Request failed (${response.status})`)
}
export async function request<T = any>(path: string, options: Options = {}): Promise<T> {
  const response = await send(path, options)
  if (!response.ok) return fail(response)
  if (response.status === 204) return undefined as T
  return response.json().catch(() => ({})) as Promise<T>
}
/** GET when `data` is undefined, otherwise POST (the shape the editor has always used). */
export const api = <T = any>(path: string, data?: unknown) => request<T>(path, { method: data === undefined ? 'GET' : 'POST', body: data })
export const apiPatch = <T = any>(path: string, data: unknown) => request<T>(path, { method: 'PATCH', body: data })
export const apiDelete = <T = any>(path: string) => request<T>(path, { method: 'DELETE' })
export async function apiBlob(path: string, data?: unknown): Promise<Blob> {
  const response = await send(path, { method: data === undefined ? 'GET' : 'POST', body: data, accept: 'blob' })
  if (!response.ok) return fail(response)
  return response.blob()
}
/** Document-scoped routes live under /api/d/:id. */
export const docPath = (id: string, rest: string) => `/api/d/${encodeURIComponent(id)}/${rest.replace(/^\//, '')}`
