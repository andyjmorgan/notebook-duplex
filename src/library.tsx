// The library catalogue: folders, documents and tags for the whole deployment, plus the mutations the UI offers.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, apiDelete, apiPatch } from './api'
import type { DocumentSummary, Library, TagCount } from './types'

export const LAST_DOC_KEY = 'notebook-duplex.lastDocument'
export const lastOpened = {
  get: () => { try { return localStorage.getItem(LAST_DOC_KEY) ?? '' } catch { return '' } },
  set: (id: string) => { try { if (id) localStorage.setItem(LAST_DOC_KEY, id); else localStorage.removeItem(LAST_DOC_KEY) } catch {} },
}
/** Folder paths are normalised: leading slash, no trailing slash, '/' for the root. */
export function normaliseFolder(path: string) {
  const clean = '/' + path.trim().split('/').map(s => s.trim()).filter(Boolean).join('/')
  return clean
}
export const folderName = (path: string) => path === '/' ? 'Library' : path.split('/').pop() ?? path
export const parentFolder = (path: string) => path === '/' ? '' : normaliseFolder(path.split('/').slice(0, -1).join('/'))

type LibraryContext = {
  library: Library | undefined; tags: TagCount[]; loaded: boolean; error: string
  refresh: () => Promise<void>
  createDocument: (input: { title?: string; folder?: string; markdown?: string; tags?: string[] }) => Promise<DocumentSummary>
  createFolder: (path: string) => Promise<void>
  deleteFolder: (path: string) => Promise<void>
  update: (id: string, patch: { title?: string; folder?: string; tags?: string[]; frontmatter?: Record<string, unknown> }) => Promise<DocumentSummary>
  remove: (id: string) => Promise<void>
  restore: (id: string) => Promise<void>
  /** Patch the local copy right away (title typed in the header) so the tree follows without a round trip. */
  patchLocal: (id: string, patch: Partial<DocumentSummary>) => void
}
const Ctx = createContext<LibraryContext | null>(null)

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<Library>()
  const [tags, setTags] = useState<TagCount[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const inflight = useRef<Promise<void>>(undefined)
  const refresh = useCallback(() => inflight.current ??= (async () => {
    try {
      const [lib, t] = await Promise.all([api<Library>('/api/library'), api<TagCount[]>('/api/tags').catch(() => [] as TagCount[])])
      setLibrary({ folders: lib.folders ?? [], documents: lib.documents ?? [] }); setTags(Array.isArray(t) ? t : []); setError('')
    } catch (e) { setError((e as Error).message) } finally { setLoaded(true); inflight.current = undefined }
  })(), [])
  useEffect(() => { void refresh(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000); return () => clearInterval(timer) }, [refresh])

  const value = useMemo<LibraryContext>(() => ({
    library, tags, loaded, error, refresh,
    createDocument: async input => { const doc = await api<DocumentSummary>('/api/documents', input); void refresh(); return doc },
    createFolder: async path => { await api('/api/folders', { path: normaliseFolder(path) }); await refresh() },
    deleteFolder: async path => { await apiDelete('/api/folders?path=' + encodeURIComponent(path)); await refresh() },
    update: async (id, patch) => { const doc = await apiPatch<DocumentSummary>(`/api/documents/${encodeURIComponent(id)}`, patch); void refresh(); return doc },
    remove: async id => { await apiDelete(`/api/documents/${encodeURIComponent(id)}`); setLibrary(l => l && { ...l, documents: l.documents.filter(d => d.id !== id) }); void refresh() },
    restore: async id => { await api(`/api/documents/${encodeURIComponent(id)}/restore`, {}); await refresh() },
    patchLocal: (id, patch) => setLibrary(l => l && { ...l, documents: l.documents.map(d => d.id === id ? { ...d, ...patch } : d) }),
  }), [library, tags, loaded, error, refresh])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export function useLibrary() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLibrary outside LibraryProvider')
  return ctx
}
/** Folder tree built from both explicit folders and the folders documents sit in. */
export type FolderNode = { path: string; name: string; children: FolderNode[]; documents: DocumentSummary[]; count: number }
export function buildTree(library: Library | undefined): FolderNode {
  const nodes = new Map<string, FolderNode>()
  const ensure = (path: string): FolderNode => {
    let node = nodes.get(path)
    if (node) return node
    node = { path, name: folderName(path), children: [], documents: [], count: 0 }
    nodes.set(path, node)
    if (path !== '/') ensure(parentFolder(path)).children.push(node)
    return node
  }
  const root = ensure('/')
  for (const f of library?.folders ?? []) ensure(normaliseFolder(f))
  for (const d of library?.documents ?? []) ensure(normaliseFolder(d.folder || '/')).documents.push(d)
  const finish = (n: FolderNode): number => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.documents.sort((a, b) => a.title.localeCompare(b.title)); n.count = n.documents.length + n.children.reduce((s, c) => s + finish(c), 0); return n.count }
  finish(root)
  return root
}
