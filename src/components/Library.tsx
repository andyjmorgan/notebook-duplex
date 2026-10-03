import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Ellipsis, FilePlus, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Hash, Pencil, Search, Trash2 } from 'lucide-react'
import { api } from '../api'
import { buildTree, folderName, normaliseFolder, parentFolder, useLibrary, type FolderNode } from '../library'
import type { DocumentSummary, SearchResult } from '../types'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { MoveDialog, PromptDialog } from './Dialogs'
import { Player, type PlayerProps } from './Player'
import { snippetHtml } from '../pages/SearchPage'
import type { Heading } from './Outline'

// Folders start open; the ones the writer closes are remembered.
const CLOSED_KEY = 'notebook-duplex.closedFolders'
const closedStore = {
  get: (): string[] => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') } catch { return [] } },
  set: (v: string[]) => { try { localStorage.setItem(CLOSED_KEY, JSON.stringify(v)) } catch {} },
}
type Dialog = { kind: 'rename'; doc: DocumentSummary } | { kind: 'move'; doc: DocumentSummary } | { kind: 'newFolder'; parent: string } | null

export type LibraryProps = {
  currentId?: string
  outline?: { headings: Heading[]; onJump: (pos: number) => void; words: number }
  player?: PlayerProps
}
export function LibraryColumn({ currentId, outline, player }: LibraryProps) {
  const lib = useLibrary()
  const navigate = useNavigate()
  const tree = useMemo(() => buildTree(lib.library), [lib.library])
  const current = lib.library?.documents.find(d => d.id === currentId)
  const [closed, setClosed] = useState<Set<string>>(() => new Set(closedStore.get()))
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [outlineOpen, setOutlineOpen] = useState(() => { try { return localStorage.getItem('notebook-duplex.outlineOpen') !== '0' } catch { return true } })
  // The folder holding the current document is always visible.
  useEffect(() => {
    if (!current) return
    let path = normaliseFolder(current.folder || '/')
    const next = new Set(closed); let changed = false
    while (path) { if (next.has(path)) { next.delete(path); changed = true } path = parentFolder(path) }
    if (changed) { setClosed(next); closedStore.set([...next]) }
  }, [current?.folder, current?.id])
  const toggle = (path: string) => setClosed(prev => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); closedStore.set([...next]); return next })

  const newDocument = async (folder = current?.folder ?? '/') => {
    try { const doc = await lib.createDocument({ title: 'Untitled', folder }); navigate(`/d/${doc.id}`) } catch (e) { toast.error((e as Error).message) }
  }
  const removeDocument = async (doc: DocumentSummary) => {
    try {
      await lib.remove(doc.id)
      if (doc.id === currentId) navigate('/')
      toast(`Deleted “${doc.title}”.`, { action: { label: 'Undo', onClick: () => void lib.restore(doc.id).then(() => { toast.success(`Restored “${doc.title}”.`); if (doc.id === currentId) navigate(`/d/${doc.id}`) }).catch(e => toast.error(e.message)) }, duration: 8000 })
    } catch (e) { toast.error((e as Error).message) }
  }
  const removeFolder = async (path: string) => { try { await lib.deleteFolder(path); toast(`Removed folder ${path}.`) } catch (e) { toast.error((e as Error).message) } }
  const docMenu = (doc: DocumentSummary): MenuItem[] => [
    { icon: <Pencil size={14} />, label: 'Rename', onSelect: () => setDialog({ kind: 'rename', doc }) },
    { icon: <FolderInput size={14} />, label: 'Move to folder…', onSelect: () => setDialog({ kind: 'move', doc }) },
    { separator: true, label: '' },
    { icon: <Trash2 size={14} />, label: 'Delete', danger: true, onSelect: () => void removeDocument(doc) },
  ]
  const folderMenu = (node: FolderNode): MenuItem[] => [
    { icon: <FilePlus size={14} />, label: 'New document here', onSelect: () => void newDocument(node.path) },
    { icon: <FolderPlus size={14} />, label: 'New folder inside', onSelect: () => setDialog({ kind: 'newFolder', parent: node.path }) },
    ...(node.path !== '/' ? [{ separator: true, label: '' }, { icon: <Trash2 size={14} />, label: 'Delete folder', danger: true, disabled: node.count > 0, title: node.count > 0 ? 'Only empty folders can be deleted' : undefined, onSelect: () => void removeFolder(node.path) }] : []),
  ]
  const showMenu = (e: ReactMouseEvent, items: MenuItem[]) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items }) }

  const renderFolder = (node: FolderNode, depth: number) => {
    const isOpen = !closed.has(node.path) || node.path === '/'
    return (
      <div key={node.path} className="tree-folder">
        {node.path !== '/' && (
          <div className={`tree-row folder ${isOpen ? 'open' : ''}`} style={{ paddingLeft: depth * 12 + 6 }} onContextMenu={e => showMenu(e, folderMenu(node))}>
            <button className="tree-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => toggle(node.path)}>
              {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              {isOpen ? <FolderOpen size={15} aria-hidden /> : <Folder size={15} aria-hidden />}
              <span className="tree-name">{node.name}</span>
              <span className="tree-count">{node.count}</span>
            </button>
            <button className="tree-more" aria-label={`Folder menu for ${node.name}`} onClick={e => showMenu(e, folderMenu(node))}><Ellipsis size={14} aria-hidden /></button>
          </div>
        )}
        {isOpen && (
          <div className="tree-children">
            {node.children.map(c => renderFolder(c, node.path === '/' ? depth : depth + 1))}
            {node.documents.map(d => (
              <div key={d.id} className={`tree-row doc ${d.id === currentId ? 'current' : ''}`} style={{ paddingLeft: (node.path === '/' ? depth : depth + 1) * 12 + 6 }} onContextMenu={e => showMenu(e, docMenu(d))}>
                <Link to={`/d/${d.id}`} className="tree-link" aria-current={d.id === currentId ? 'page' : undefined} title={d.title}><FileText size={14} aria-hidden /><span className="tree-name">{d.title || 'Untitled'}</span></Link>
                <button className="tree-more" aria-label={`Menu for ${d.title}`} onClick={e => showMenu(e, docMenu(d))}><Ellipsis size={14} aria-hidden /></button>
              </div>
            ))}
            {node.path === '/' && !node.children.length && !node.documents.length && lib.loaded && <p className="caption tree-empty">No documents yet.</p>}
          </div>
        )}
      </div>
    )
  }
  const maxTag = Math.max(1, ...lib.tags.map(t => t.count))

  return (
    <nav className="library" aria-label="Library">
      <LibrarySearch />
      <div className="library-actions">
        <button className="quiet small" onClick={() => void newDocument()} title="New document in the current folder"><FilePlus size={14} aria-hidden /> New document</button>
        <button className="quiet small" onClick={() => setDialog({ kind: 'newFolder', parent: current?.folder ?? '/' })} title="New folder"><FolderPlus size={14} aria-hidden /> New folder</button>
      </div>
      <div className="library-scroll">
        <div className="tree" role="tree" aria-label="Folders">{renderFolder(tree, 0)}</div>
        {lib.tags.length > 0 && (
          <div className="tag-cloud" aria-label="Tags">
            <div className="outline-title">Tags</div>
            <div className="tag-cloud-list">{lib.tags.map(t => <Link key={t.tag} to={`/tags/${encodeURIComponent(t.tag)}`} className="tag-chip" style={{ fontSize: 11 + Math.round(3 * t.count / maxTag) }} title={`${t.count} ${t.count === 1 ? 'document' : 'documents'}`}><Hash size={10} aria-hidden />{t.tag}<span className="tag-count">{t.count}</span></Link>)}</div>
          </div>
        )}
        {outline && (
          <div className="outline">
            <button className="outline-title outline-toggle" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(o => { try { localStorage.setItem('notebook-duplex.outlineOpen', o ? '0' : '1') } catch {} return !o })}>{outlineOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />} Contents</button>
            {outlineOpen && <div id="toc">
              {outline.headings.length ? outline.headings.map(h => <button key={h.id || 'pos-' + h.pos} data-position={h.pos} style={{ paddingLeft: (h.level - 1) * 12 + 12 }} onClick={() => outline.onJump(h.pos)}>{h.text || 'Untitled section'}</button>) : <p>Add headings to build an outline.</p>}
            </div>}
          </div>
        )}
      </div>
      {(outline || player) && (
        <div className="outline-foot">
          {outline && <div className="outline-note">{outline.words} words</div>}
          {player && <Player {...player} />}
        </div>
      )}
      <ContextMenu position={menu} items={menu?.items ?? []} onClose={useCallback(() => setMenu(null), [])} />
      {dialog?.kind === 'rename' && <PromptDialog title="Rename document" label="Title" initial={dialog.doc.title} onClose={() => setDialog(null)} onSubmit={async v => { await lib.update(dialog.doc.id, { title: v });  }} />}
      {dialog?.kind === 'move' && <MoveDialog folders={lib.library?.folders ?? []} current={dialog.doc.folder} onClose={() => setDialog(null)} onMove={async f => { await lib.update(dialog.doc.id, { folder: normaliseFolder(f) }); toast(`Moved to ${normaliseFolder(f)}.`) }} />}
      {dialog?.kind === 'newFolder' && <PromptDialog title="New folder" label={`Inside ${dialog.parent === '/' ? 'the library' : dialog.parent}`} placeholder="Folder name" submitLabel="Create" onClose={() => setDialog(null)} onSubmit={async v => { const path = normaliseFolder((dialog.parent === '/' ? '' : dialog.parent) + '/' + v); await lib.createFolder(path); setClosed(prev => { const n = new Set(prev); n.delete(path); closedStore.set([...n]); return n }) }} />}
    </nav>
  )
}

/** Live search over the library with keyboard navigation; Enter on "all results" goes to /search. */
function LibrarySearch() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [index, setIndex] = useState(-1)
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const seq = useRef(0)
  useEffect(() => {
    clearTimeout(timer.current)
    if (!q.trim()) { setResults([]); setIndex(-1); return }
    const n = ++seq.current
    timer.current = setTimeout(() => { api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q.trim())}&limit=8`).then(r => { if (n === seq.current) { setResults(r.results ?? []); setIndex(-1) } }).catch(() => {}) }, 180)
    return () => clearTimeout(timer.current)
  }, [q])
  const openResult = (r: SearchResult) => { navigate(`/d/${r.id}`); setQ(''); setResults([]) }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (index >= 0 && results[index]) openResult(results[index]); else if (q.trim()) { navigate(`/search?q=${encodeURIComponent(q.trim())}`); setResults([]) } }
    else if (e.key === 'Escape') { setQ(''); setResults([]); (e.target as HTMLInputElement).blur() }
  }
  const show = focused && q.trim().length > 0
  return (
    <div className="library-search" role="search">
      <Search size={14} aria-hidden className="search-icon" />
      <input type="search" value={q} placeholder="Search the library" aria-label="Search the library" aria-expanded={show} aria-controls="search-results" onChange={e => setQ(e.target.value)} onKeyDown={onKey} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 120)} />
      {show && (
        <div id="search-results" className="search-results" role="listbox">
          {results.map((r, i) => (
            <button key={r.id} role="option" aria-selected={i === index} className={`search-result ${i === index ? 'selected' : ''}`} onMouseDown={e => e.preventDefault()} onClick={() => openResult(r)}>
              <span className="result-title">{r.title}</span>
              {r.snippet && <span className="result-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippet) }} />}
              {r.folder && r.folder !== '/' && <span className="caption">{r.folder}</span>}
            </button>
          ))}
          {!results.length && <p className="caption search-empty">Searching…</p>}
          <Link className="search-all" to={`/search?q=${encodeURIComponent(q.trim())}`} onMouseDown={e => e.preventDefault()} onClick={() => { setQ(''); setResults([]) }}>All results for “{q.trim()}” <kbd>↵</kbd></Link>
        </div>
      )}
    </div>
  )
}
export { folderName }
