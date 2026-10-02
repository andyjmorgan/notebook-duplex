const KEY = 'notebook-duplex.key'
export class Unauthorized extends Error { constructor() { super('The notebook key was not accepted.') } }
export const apiKey = {
  get: () => { try { return localStorage.getItem(KEY) ?? '' } catch { return '' } },
  set: (value: string) => { try { if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY) } catch {} },
}
export let lastBuild = ''
export async function api<T = any>(path: string, data?: unknown, key = apiKey.get()): Promise<T> {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
  const build = response.headers.get('x-build'); if (build) lastBuild = build
  if (response.status === 401) throw new Unauthorized()
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? 'Request failed')
  return result as T
}
export async function apiBlob(path: string, data: unknown, key = apiKey.get()): Promise<Blob> {
  const response = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  if (response.status === 401) throw new Unauthorized()
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error ?? 'Request failed') }
  return response.blob()
}
