import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import UniqueID from '@tiptap/extension-unique-id'
import { Markdown } from '@tiptap/markdown'
import Image from '@tiptap/extension-image'
import { Bold, Check, Clipboard, Copy, Heading2, Pause, Play, Scissors, Sparkles, Table, Type, Download, Upload } from 'lucide-react'
import { NotebookCodeBlock } from './editor/mermaid'
import { ImageMarkdown } from './editor/imageMarkdown'
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { api, apiBlob, apiPatch, docPath, Unauthorized } from './api'
import * as apiModule from './api'
import { auth, type AuthUser } from './auth'
import { lastOpened, normaliseFolder, useLibrary } from './library'
import type { DocumentMeta, DocumentSummary, Proposal, State } from './types'
import { NotebookAnnotations, annotationsKey, hostFor, releaseHosts } from './editor/annotations'
import { TkDirectives, directivesPluginKey, findDirectives, directiveKey, type DirectiveStatus } from './editor/directives'
import { ReadAloudHighlight, readAloudKey } from './editor/readAloud'
import { WikiLinks, wikilinksKey } from './editor/wikilinks'
import { buildScript, utteranceAt, type Utterance } from './reading/script'
import { ReadAloudPlayer, type PlayerSnapshot } from './reading/player'
import { OffscreenMarkers, type Marker } from './components/OffscreenMarkers'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { SuggestionCard } from './components/SuggestionCard'
import { CommandBar } from './components/CommandBar'
import { SlashMenu, slashChoices } from './components/SlashMenu'
import { Toolbar, runAction } from './components/Toolbar'
import type { Heading } from './components/Outline'
import { Rail, type HeldRequest } from './components/Rail'
import { AppBar } from './components/AppBar'
import { LibraryColumn } from './components/Library'
import { DocumentHeader } from './components/DocumentHeader'
import { RelatedPanel } from './components/RelatedPanel'
import { MoveDialog } from './components/Dialogs'

const initialMarkdown = `Write with your Claude session beside you.

This is your document. Keep writing while Claude researches a claim or drafts a clearer paragraph. Nothing changes until you accept it, right here in the text.

## Try the collaboration

Put the caret in this paragraph and press ⌘K, or type /agent and Space, then ask for a clearer version.

Use the local test suggestion to try the review flow without connecting Claude. Rewrite its target paragraph before accepting to see stale protection.

## A simple table

| Idea | Next step |
| --- | --- |
| Write freely | Let the agent work in the margin |
| Review deliberately | Accept only what helps |

## A note to return to

[tk: Find a primary source about local-first software.]
`
const idTypes = ['paragraph', 'heading', 'table', 'tableRow', 'tableCell', 'tableHeader', 'listItem', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'image']
const PROOFREAD_TABLE_INSTRUCTION = 'Proofread this table for spelling, grammar, consistency and clarity. Its cells are the blocks in scope, in reading order. Return replace proposals only for cells where a change helps; otherwise report completion. Preserve the writer’s meaning.'
const AGENT_BUSY = 'Claude is working on this page. Read aloud is available when it finishes.'
const activeJob = (j: { status: string }) => ['queued', 'running', 'needs_permission'].includes(j.status)
const PROOFREAD_INSTRUCTION = 'Proofread the selected paragraph for spelling, grammar, and clarity. Return a replace proposal only if a change helps; otherwise report completion. Preserve the writer’s meaning and voice.'
const notify = (message: string) => { toast(message) }

export function Notebook({ docId, user }: { docId: string; user: AuthUser }) {
  const navigate = useNavigate()
  const lib = useLibrary()
  const [mcpUrl, setMcpUrl] = useState(location.origin + '/mcp')
  const [state, setState] = useState<State>()
  const [meta, setMeta] = useState<DocumentMeta>()
  const [sessionId, setSessionId] = useState('')
  const [mode, setMode] = useState<'editing' | 'reading'>('editing')
  const [saveState, setSaveState] = useState('Opening…')
  const [connectionLabel, setConnectionLabel] = useState('Connecting')
  const [updateReady, setUpdateReady] = useState(false)
  const [mermaidFailed, setMermaidFailed] = useState(false)
  const [moving, setMoving] = useState(false)
  useEffect(() => { const onFail = () => setMermaidFailed(true); window.addEventListener('notebook:chunk-failed', onFail); return () => window.removeEventListener('notebook:chunk-failed', onFail) }, [])
  const buildRef = useRef<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [proofread, setProofread] = useState(false)
  const [command, setCommand] = useState<{ open: boolean; initial: string; scopeId?: string; selection?: string; scopeLabel?: string; anchor: { top: number; left: number } | null }>({ open: false, initial: '', anchor: null })
  useEffect(() => { const onAsk = (e: Event) => { const d = (e as CustomEvent).detail; live.current.openCommand('', undefined, { blockId: d.blockId, label: d.label }) }; window.addEventListener('notebook:ask', onAsk); return () => window.removeEventListener('notebook:ask', onAsk) }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string; blockId?: string; pos?: number } | null>(null)
  const [reading, setReading] = useState<PlayerSnapshot>({ status: 'idle', index: 0, total: 0, speed: 1 })
  const [held, setHeld] = useState<HeldRequest[]>([])
  const readingRef = useRef(false), heldRef = useRef<HeldRequest[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])
  const [tick, setTick] = useState(0)
  const [slashIndex, setSlashIndex] = useState(0)

  // Everything document-scoped is keyed by docRef; syncs capture the id they were queued for.
  const docRef = useRef(docId)
  const ready = useRef(false), dirty = useRef(false), syncing = useRef(false), revision = useRef(0), lastEdit = useRef(0)
  const syncChain = useRef<Promise<void>>(Promise.resolve())
  const pendingSync = useRef<ReturnType<typeof setTimeout>>(undefined)
  const proofreadSeen = useRef(new Map<string, string>())
  const firedDirectives = useRef(new Set<string>())
  const localDirectives = useRef(new Map<string, 'queued'>())
  const slashRef = useRef({ open: false, index: 0 })
  const stateRef = useRef<State>(undefined)
  const metaRef = useRef<DocumentMeta>(undefined)
  const libRef = useRef(lib); libRef.current = lib
  const pageRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  stateRef.current = state; metaRef.current = meta
  // Editor key handlers are created once; they reach the latest render through this ref.
  const live = useRef({ openCommand: (_initial?: string, _selection?: string, _scope?: { blockId: string; label: string }) => {}, executeSlash: (_cmd?: string) => {}, accept: async (_p: Proposal, _edited: string) => {}, currentBlockId: (): string | undefined => undefined, currentBlockChain: (): string[] => [], onUpdate: () => {}, docChanged: () => {}, flushHeld: async () => {}, showUtterance: (_u: Utterance | null) => {}, editor: (): Editor | null => null, openDocument: (_id: string) => {} })

  // One player for the page. Audio is fetched at speed 1 and paced with playbackRate, so the clip cache survives speed changes.
  const [player] = useState(() => new ReadAloudPlayer({
    tts: text => apiBlob('/api/tts', { text, speed: 1 }),
    describe: d => api<{ text: string }>('/api/describe', d).then(r => r.text),
    onChange: s => { const was = readingRef.current; readingRef.current = s.status !== 'idle'; setReading(s); if (was && !readingRef.current) void live.current.flushHeld() },
    onUtterance: u => live.current.showUtterance(u),
    onError: notify,
  }))

  const editor = useEditor({
    extensions: [StarterKit.configure({ codeBlock: false }), NotebookCodeBlock, TableKit.configure({ table: { resizable: false } }), UniqueID.configure({ types: idTypes }), Markdown, Image.configure({ allowBase64: true, inline: true }), ImageMarkdown, NotebookAnnotations, TkDirectives, ReadAloudHighlight, WikiLinks.configure({ onOpen: id => live.current.openDocument(id) })],
    content: '', contentType: 'markdown', editable: false,
    editorProps: {
      attributes: { 'aria-label': 'Document', spellcheck: 'true' },
      // Plain-text pastes that look like Markdown (images, headings, lists, tables, fences) are parsed as Markdown.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        const html = event.clipboardData?.getData('text/html') ?? ''
        if (!text || html || !/!\[[^\]]*\]\([^)]+\)|^\s*(#{1,6} |[-*+] |\d+\. |> |```|\|.*\|)/m.test(text)) return false
        const ed = live.current.editor()
        const parsed = ed?.markdown?.parse(text)
        if (!ed || !parsed?.content?.length) return false
        event.preventDefault()
        const $from = view.state.selection.$from
        const onlyInline = parsed.content.length === 1 && parsed.content[0].type === 'paragraph'
        const emptyBlock = $from.parent.isTextblock && $from.parent.content.size === 0
        if (onlyInline && !emptyBlock) ed.chain().focus().insertContent(parsed.content[0].content ?? []).run()
        else ed.chain().focus().insertContent(parsed.content).run()
        return true
      },
      handleKeyDown(view, event) {
        if (slashRef.current.open && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
          event.preventDefault()
          const choices = slashChoices(view.state.selection.$from.parent.textContent)
          if (event.key === 'Escape') { slashRef.current.open = false; setTick(t => t + 1) }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSlashIndex(i => (i + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length)
          else live.current.executeSlash(choices[slashRef.current.index]?.command)
          return true
        }
        if (event.key === ' ' && view.state.selection.$from.parent.textContent === '/agent') {
          event.preventDefault()
          const from = view.state.selection.$from.start()
          view.dispatch(view.state.tr.delete(from, from + 6))
          live.current.openCommand(); return true
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); live.current.openCommand(); return true }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          const ids = live.current.currentBlockChain()
          const p = stateRef.current?.proposals.find(x => x.status === 'pending' && !x.stale && x.type === 'replace' && ids.includes(x.blockId ?? ''))
          if (p) { event.preventDefault(); void live.current.accept(p, p.after ?? ''); return true }
        }
        return false
      },
    },
    onUpdate({ transaction }) { if (!ready.current) return; dirty.current = true; lastEdit.current = Date.now(); queueSync(); if (transaction.docChanged) live.current.docChanged(); live.current.onUpdate() },
  })

  const view = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor) return null
      const sel = editor.state.selection
      const parent = sel.$from.parent
      const slashText = sel.empty && parent.type.name === 'paragraph' && /^\/[a-z0-9]*$/.test(parent.textContent) ? parent.textContent : ''
      const headings: Heading[] = []
      editor.state.doc.descendants((node, pos) => { if (node.type.name === 'heading') headings.push({ id: node.attrs.id, text: node.textContent, level: node.attrs.level, pos }) })
      return {
        slashText, from: sel.from, editable: editor.isEditable,
        flags: { bold: editor.isActive('bold'), italic: editor.isActive('italic'), h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }), inTable: editor.isActive('table') },
        words: editor.getText().trim().split(/\s+/).filter(Boolean).length, headings,
      }
    },
  })
  const slashOpen = Boolean(view?.slashText) && mode === 'editing' && slashChoices(view!.slashText).length > 0
  slashRef.current = { open: slashOpen, index: slashIndex }
  useEffect(() => { setSlashIndex(0) }, [view?.slashText])

  // Prefer the live DOM selection: a keypress can arrive before ProseMirror has read a fresh click.
  function caretPosition(): ResolvedPos | undefined {
    if (!editor) return
    try {
      const sel = window.getSelection()
      if (sel?.anchorNode && editor.view.dom.contains(sel.anchorNode)) return editor.state.doc.resolve(editor.view.posAtDOM(sel.anchorNode, sel.anchorOffset))
    } catch {}
    return editor.state.selection.$from
  }
  const isTextBlock = (node: PMNode) => ['paragraph', 'heading'].includes(node.type.name) && node.attrs.id
  function currentBlockId(): string | undefined {
    const $pos = caretPosition()
    if (!$pos) return
    for (let depth = $pos.depth; depth >= 0; depth--) { const node = $pos.node(depth); if (isTextBlock(node)) return node.attrs.id as string }
    // Between blocks (e.g. a click that landed on the editor root): prefer the block just before the position.
    const near = $pos.nodeBefore ?? $pos.nodeAfter
    if (near && isTextBlock(near)) return near.attrs.id as string
  }
  function currentBlockChain(): string[] {
    const $pos = caretPosition()
    if (!$pos) return []
    const ids: string[] = []
    for (let depth = $pos.depth; depth >= 0; depth--) { const node = $pos.node(depth); if (node.attrs?.id) ids.push(node.attrs.id) }
    const first = currentBlockId(); if (first && !ids.includes(first)) ids.unshift(first)
    return ids
  }
  function blockPosition(id: string) {
    let found: { pos: number; size: number } | undefined
    editor?.state.doc.descendants((node, pos) => { if (!found && node.attrs?.id === id) found = { pos, size: node.nodeSize }; return !found })
    return found
  }

  const sync = useCallback(() => {
    if (!editor) return Promise.resolve()
    const id = docRef.current
    syncChain.current = syncChain.current.then(async () => {
      if (docRef.current !== id) return
      syncing.current = true
      try {
        const json = editor.getJSON()
        const saved = await api(docPath(id, 'sync'), { json, title: titleRef.current?.value.trim() || 'Untitled', expectedRevision: revision.current })
        if (docRef.current !== id) return
        revision.current = saved.revision
        dirty.current = JSON.stringify(json) !== JSON.stringify(editor.getJSON())
        setSaveState(dirty.current ? 'Saving…' : 'Saved')
      } finally { syncing.current = false }
    }).catch(error => {
      dirty.current = true
      if (error instanceof Unauthorized) setSaveState('Signed out · unsaved')
      else if (/revision changed/.test(error.message)) void reload()
      else { setSaveState('Unsaved · server unreachable'); notify(error.message) }
    })
    return syncChain.current
  }, [editor])
  function queueSync() { clearTimeout(pendingSync.current); setSaveState('Saving…'); pendingSync.current = setTimeout(() => { pendingSync.current = undefined; void sync() }, 400) }
  async function flush() {
    if (!dirty.current && !pendingSync.current) return
    clearTimeout(pendingSync.current); pendingSync.current = undefined
    await sync()
    if (dirty.current) throw new Error('Your latest change has not saved yet. Try again in a moment.')
  }
  // Pending typing is saved before the browser leaves for the identity provider.
  const flushRef = useRef(flush); flushRef.current = flush
  useEffect(() => auth.beforeLeave(() => flushRef.current().catch(() => {})), [])

  const refresh = async () => { const id = docRef.current; try { const next = await api<State>(docPath(id, 'state?lite=1')); if (docRef.current === id) setState(prev => ({ ...next, document: { ...next.document, json: prev?.document.json ?? null, markdown: prev?.document.markdown ?? '' } })) } catch {} }
  const loadMeta = useCallback(async () => {
    const id = docRef.current
    try { const m = await api<DocumentMeta>(`/api/documents/${encodeURIComponent(id)}`); if (docRef.current === id) setMeta({ ...m, related: m.related ?? [], links: m.links ?? { out: [], in: [] }, tags: m.tags ?? [], frontmatter: m.frontmatter ?? {} }) } catch {}
  }, [])

  // Loading a document is not an edit: it must not be undoable, or ⌘Z could step back to an empty page.
  function loadContent(content: any, contentType?: 'markdown') {
    if (!editor) return
    editor.chain().setMeta('addToHistory', false).setContent(content, { emitUpdate: false, contentType }).run()
  }
  async function reload() {
    if (!editor) return
    const id = docRef.current
    const fresh = await api<State>(docPath(id, 'state'))
    if (docRef.current !== id) return
    revision.current = fresh.document.revision
    if (fresh.document.json) { player.clear(); loadContent(fresh.document.json) }
    for (const d of findDirectives(editor.state.doc)) if (d.complete) firedDirectives.current.add(directiveKey(d))
    dirty.current = false; setSaveState('Saved')
    setState(fresh)
  }

  // Connection and polling. Re-runs for every document: the previous one is flushed, reading stops, held asks are dropped.
  useEffect(() => {
    if (!editor) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (cancelled) return
      try {
        const next = await api<State>(docPath(docId, 'state?lite=1'))
        if (!cancelled) setState(prev => ({ ...next, document: { ...next.document, json: prev?.document.json ?? null, markdown: prev?.document.markdown ?? '' } }))
        const lastBuild = apiModule.lastBuild
        if (!cancelled && lastBuild && buildRef.current && lastBuild !== buildRef.current) setUpdateReady(true)
        if (!cancelled && lastBuild && !buildRef.current) buildRef.current = lastBuild
      } catch (e) {
        if (e instanceof Unauthorized) return
        setConnectionLabel('Reconnecting…')
      }
      timer = setTimeout(poll, 1000)
    }
    const switchAway = async () => {
      const previous = docRef.current
      if (previous === docId || !ready.current) return
      ready.current = false; editor.setEditable(false)
      clearTimeout(pendingSync.current); pendingSync.current = undefined
      if (dirty.current) { try { await sync() } catch {} }
    }
    const connect = async () => {
      try {
        await switchAway()
        if (cancelled) return
        docRef.current = docId
        player.stop(); heldRef.current = []; setHeld([])
        firedDirectives.current.clear(); localDirectives.current.clear(); proofreadSeen.current.clear()
        revision.current = 0; dirty.current = false
        setState(undefined); setMeta(undefined); setMarkers([]); setCommand(c => ({ ...c, open: false })); setMenu(null); setSaveState('Opening…')
        const [me, initial] = await Promise.all([api<{ mcpUrl?: string }>('/api/me').catch(() => ({} as { mcpUrl?: string })), api<State>(docPath(docId, 'state')), loadMeta()])
        if (cancelled) return
        if (me.mcpUrl) setMcpUrl(me.mcpUrl)
        revision.current = initial.document.revision
        player.clear()
        const doc = initial.document as State['document'] & { markdown?: string | null }
        // A document the server has never stored: imported Markdown seeds it; the very first document in a library gets the welcome text.
        const welcome = !doc.json && !doc.markdown?.trim() && initial.document.revision === 0 && (libRef.current.library?.documents.length ?? 1) <= 1
        if (doc.json) loadContent(doc.json)
        else loadContent(doc.markdown?.trim() ? doc.markdown : welcome ? initialMarkdown : '', 'markdown')
        for (const d of findDirectives(editor.state.doc)) if (d.complete) firedDirectives.current.add(directiveKey(d))
        const title = metaRef.current?.title || initial.document.title
        if (titleRef.current) titleRef.current.value = welcome && (!title || title === 'Untitled') ? 'Working notes' : title || 'Untitled'
        ready.current = true; dirty.current = !doc.json
        editor.setEditable(mode === 'editing')
        editor.commands.focus('start')
        if (dirty.current) await flush(); else setSaveState('Saved')
        if (cancelled) return
        setState(initial)
        lastOpened.set(docId)
        void poll()
      } catch (e) {
        if (cancelled) return
        if (e instanceof Unauthorized) { setSaveState('Signed out'); return }
        if (/not found/i.test((e as Error).message)) { notify('That document does not exist any more.'); navigate('/', { replace: true }); return }
        setConnectionLabel((e as Error).message); setSaveState('Server required')
        timer = setTimeout(connect, 3000)
      }
    }
    void connect()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [editor, docId])
  // Catalogue metadata (related, backlinks, tags) can change from elsewhere; keep it loosely fresh.
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === 'visible') void loadMeta() }, 15000); return () => clearInterval(t) }, [loadMeta])
  useEffect(() => { document.title = `${meta?.title || 'Notebook'} · Notebook Duplex` }, [meta?.title])
  // A rename from the library tree updates the title field unless the writer is typing in it.
  const libraryTitle = lib.library?.documents.find(d => d.id === docId)?.title
  useEffect(() => {
    // Only once this document is the one in the editor: mid-switch the prop is already the new id while the old one is still flushing.
    if (!ready.current || docRef.current !== docId || metaRef.current?.id !== docId) return
    if (titleRef.current && libraryTitle && document.activeElement !== titleRef.current && titleRef.current.value !== libraryTitle) { titleRef.current.value = libraryTitle; setMeta(m => m && { ...m, title: libraryTitle }) }
  }, [libraryTitle, docId])

  // Wikilinks resolve against the library's titles and the links the server parsed from this document.
  const resolver = useMemo(() => {
    const byTitle = new Map<string, { id: string; title: string }>()
    for (const d of lib.library?.documents ?? []) byTitle.set(d.title.trim().toLowerCase(), { id: d.id, title: d.title })
    for (const l of meta?.links?.out ?? []) byTitle.set(l.title.trim().toLowerCase(), { id: l.id, title: l.title })
    const aliases = Array.isArray(meta?.frontmatter?.aliases) ? meta!.frontmatter.aliases as string[] : []
    for (const a of aliases) if (typeof a === 'string' && meta) byTitle.set(a.trim().toLowerCase(), { id: meta.id, title: meta.title })
    return (title: string) => byTitle.get(title.trim().toLowerCase())
  }, [lib.library, meta?.links?.out, meta?.frontmatter?.aliases, meta?.id, meta?.title])
  useEffect(() => { if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(wikilinksKey, { resolve: resolver }).setMeta('addToHistory', false)) }, [editor, resolver])

  // Reflect server state into the document
  useEffect(() => {
    if (!editor || !state) return
    const proposals = state.proposals.filter(p => p.status === 'pending')
    const queued = state.jobs.filter(j => j.status === 'queued')
    const directiveStatus: DirectiveStatus = new Map()
    for (const j of state.jobs) if (j.directive && j.blockIds[0]) directiveStatus.set(`${j.blockIds[0]}|${j.directive}`, j.status === 'queued' ? 'queued' : ['running', 'needs_permission'].includes(j.status) ? 'working' : j.status === 'completed' ? 'done' : 'failed')
    for (const [key, value] of localDirectives.current) { if (directiveStatus.has(key)) localDirectives.current.delete(key); else directiveStatus.set(key, value) }
    editor.view.dispatch(editor.state.tr.setMeta(annotationsKey, { proposals, activity: state.activity, queued, sessions: state.sessions }).setMeta(directivesPluginKey, directiveStatus).setMeta('addToHistory', false))
    releaseHosts(new Set(proposals.map(p => p.id)))
    const working = [...editor.view.dom.querySelectorAll<HTMLElement>('.agent-active')].map((element, i) => ({ id: 'w' + i, kind: 'working' as const, element }))
    setMarkers([...proposals.map(p => ({ id: p.id, kind: 'review' as const, element: hostFor(p.id) })), ...working])
    setTick(t => t + 1)
    const connected = state.sessions.filter(s => s.connected)
    if (!connected.some(s => s.id === sessionId)) setSessionId(connected[0]?.id ?? '')
    const current = connected.find(s => s.id === sessionId) ?? connected[0]
    setConnectionLabel(current ? `${current.name}${connected.length > 1 ? ` +${connected.length - 1}` : ''}` : 'No Claude connected')
  }, [state, editor, sessionId])

  useEffect(() => { editor?.setEditable(ready.current && mode === 'editing') }, [editor, mode])

  // Proofreading of settled paragraphs
  useEffect(() => {
    if (!proofread || !editor) return
    const timer = setInterval(async () => {
      const s = stateRef.current
      if (!ready.current || busy || readingRef.current || dirty.current || syncing.current || Date.now() - lastEdit.current < 2500 || !sessionId || !s) return
      if (s.jobs.some(j => j.kind === 'proofread' && ['queued', 'running'].includes(j.status))) return
      const units: { key: string; text: string; blockIds: string[]; table: boolean }[] = []
      editor.state.doc.forEach(top => {
        if (top.type.name === 'table' && top.attrs.id) {
          const ids: string[] = []; let text = ''
          top.descendants(n => { if (n.type.name === 'paragraph' && n.attrs.id && n.content.content.every(c => c.isText && !c.marks.length)) { ids.push(n.attrs.id); text += n.textContent + '\n' } })
          if (ids.length && text.trim().length > 20) units.push({ key: top.attrs.id, text, blockIds: [top.attrs.id, ...ids], table: true })
        } else top.descendants(n => { if (n.type.name === 'paragraph' && n.attrs.id && n.content.content.every(c => c.isText && !c.marks.length)) { const text = n.textContent; if (text.trim().length > 20 && !/\[tk:/.test(text)) units.push({ key: n.attrs.id, text, blockIds: [n.attrs.id], table: false }) } })
      })
      const busyBlocks = new Set(s.proposals.filter(p => p.status === 'pending').flatMap(p => [p.blockId, p.anchorBlockId, ...(p.blockIds ?? [])]).filter(Boolean) as string[])
      for (const j of s.jobs) if (j.kind === 'proofread' && !['queued', 'running'].includes(j.status)) for (const id of j.blockIds) { const u = units.find(x => x.key === id || x.blockIds.includes(id)); if (u && !proofreadSeen.current.has(u.key)) proofreadSeen.current.set(u.key, u.text) }
      const unit = units.find(u => proofreadSeen.current.get(u.key) !== u.text && !u.blockIds.some(id => busyBlocks.has(id)))
      if (!unit) return
      try { await api(docPath(docRef.current, 'jobs'), { instruction: unit.table ? PROOFREAD_TABLE_INSTRUCTION : PROOFREAD_INSTRUCTION, blockIds: unit.blockIds, sessionId, kind: 'proofread', context: unit.table ? { table: true } : undefined }); proofreadSeen.current.set(unit.key, unit.text) } catch {}
    }, 2500)
    return () => clearInterval(timer)
  }, [proofread, editor, sessionId, busy])

  function openCommand(initial = '', selection?: string, explicitScope?: { blockId: string; label: string }) {
    if (!editor || !ready.current) return
    if (mode !== 'editing') { notify('Switch to Editing to ask the agent.'); return }
    const scopeId = explicitScope?.blockId ?? currentBlockId()
    const { from, to } = editor.state.selection
    selection ??= from !== to ? editor.state.doc.textBetween(from, to, ' ').trim() || undefined : undefined
    const page = pageRef.current
    let anchor = { top: 0, left: 0 }
    if (page) {
      const rect = page.getBoundingClientRect()
      const pos = scopeId ? blockPosition(scopeId) : undefined
      // Anchor under the block's rendered box (works for diagrams whose source is hidden); fall back to the caret.
      const dom = pos ? editor.view.nodeDOM(pos.pos) as HTMLElement | null : null
      const bottom = dom?.getBoundingClientRect ? dom.getBoundingClientRect().bottom : editor.view.coordsAtPos(pos ? pos.pos + pos.size - 1 : editor.state.selection.from).bottom
      anchor = { top: bottom - rect.top + 10, left: 0 }
    }
    setCommand({ open: true, initial, scopeId, selection, anchor, scopeLabel: explicitScope?.label })
  }
  function closeCommand() { setCommand(c => ({ ...c, open: false })); editor?.commands.focus() }
  async function submitCommand(instruction: string, whole: boolean) {
    const blockIds = whole || !command.scopeId ? [] : [command.scopeId]
    const context = command.selection ? { selection: command.selection } : undefined
    // While the document is being read aloud, asks are held and sent in order once reading stops.
    if (readingRef.current) {
      heldRef.current = [...heldRef.current, { id: crypto.randomUUID(), instruction, blockIds, sessionId, context }]
      setHeld(heldRef.current); closeCommand(); notify('Held until you stop reading.'); return
    }
    await flush()
    await api(docPath(docRef.current, 'jobs'), { instruction, blockIds, sessionId, context })
    closeCommand()
    void refresh()
  }
  async function flushHeld() {
    const queue = heldRef.current
    if (!queue.length) return
    heldRef.current = []; setHeld([])
    try { await flush() } catch {}
    let sent = 0
    for (const h of queue) { try { await api(docPath(docRef.current, 'jobs'), { instruction: h.instruction, blockIds: h.blockIds, sessionId: h.sessionId, context: h.context }); sent++ } catch (e) { notify((e as Error).message) } }
    if (sent) notify(`Sent ${sent} held ${sent === 1 ? 'request' : 'requests'} to Claude.`)
    void refresh()
  }

  // Read aloud
  const agentActive = Boolean(state?.activity.length) || (state?.jobs ?? []).some(activeJob)
  function startReading(fromPos?: number) {
    if (!editor) return
    if (agentActive) { notify(AGENT_BUSY); return }
    const script = buildScript(editor.state.doc)
    if (!script.length) { notify('Nothing to read yet.'); return }
    player.start(script, fromPos === undefined ? 0 : utteranceAt(script, fromPos))
  }
  function showUtterance(u: Utterance | null) {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(readAloudKey, u ? { from: u.from, to: u.to, inline: u.inline } : null).setMeta('addToHistory', false))
    if (!u) return
    requestAnimationFrame(() => {
      const el = editor.view.dom.querySelector('.reading-now, .reading-now-block')
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.top < 150 || r.bottom > window.innerHeight - 110) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
  function executeSlash(cmd?: string) {
    if (!cmd || !editor) return
    const sel = editor.state.selection
    const from = sel.$from.start()
    editor.view.dispatch(editor.state.tr.delete(from, from + sel.$from.parent.content.size))
    slashRef.current.open = false
    if (cmd === 'agent') { openCommand(); return }
    if (cmd === 'image') { const src = window.prompt('Image URL'); if (src?.trim()) editor.chain().focus().setImage({ src: src.trim() }).run(); return }
    if (cmd === 'tk') { editor.chain().focus().insertContent('[tk: ').run(); return }
    if (cmd === 'link') { editor.chain().focus().insertContent('[[').run(); return }
    if (cmd === 'mermaid') { editor.chain().focus().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  Writer --> Notebook --> Claude\n  Claude -->|suggests| Writer' }] }).run(); return }
    if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3') editor.chain().focus().setHeading({ level: Number(cmd[1]) as 1 | 2 | 3 }).run()
    else runAction(editor, cmd)
  }

  const busyRef = useRef(false)
  async function withBusy(fn: () => Promise<void>, { quiet = false } = {}) {
    if (readingRef.current) { const e = new Error('Stop reading before reviewing suggestions.'); notify(e.message); throw e }
    if (busyRef.current && !quiet) return
    busyRef.current = true; setBusy(true)
    try { await fn() } catch (e) { notify((e as Error).message); throw e } finally { busyRef.current = false; setBusy(false); void refresh() }
  }
  const review = (data: unknown) => api(docPath(docRef.current, 'review'), data)
  const accept = async (proposal: Proposal, edited: string) => withBusy(async () => {
    if (!editor) return
    if (mode !== 'editing') throw new Error('Switch to Editing to review changes.')
    await flush()
    if (proposal.type === 'replace_text') {
      const contents: Record<string, any[]> = {}
      for (const e of proposal.edits ?? []) { if (!e.after.trim()) continue; const first = editor.markdown?.parse(e.after)?.content?.[0]; if (first?.content?.length) contents[e.blockId] = first.content }
      const result = await review({ id: proposal.id, decision: 'accept', contents })
      if (result.stale) { notify('Every affected block changed since, so nothing was replaced.'); return }
      setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'accepted' } : p) })
      const targets = (result.applied as { blockId: string; content: any[] }[]).map(a => ({ ...a, pos: blockPosition(a.blockId) })).filter(a => a.pos).sort((a, b) => b.pos!.pos - a.pos!.pos)
      let tr = editor.state.tr
      for (const t of targets) tr = tr.replaceWith(t.pos!.pos + 1, t.pos!.pos + t.pos!.size - 1, t.content.map((n: any) => editor.schema.nodeFromJSON(n)))
      editor.view.dispatch(tr)
      revision.current = result.document.revision
      dirty.current = false; setSaveState('Saved'); queueSync()
      notify(`Replaced in ${result.applied.length} ${result.applied.length === 1 ? 'block' : 'blocks'}${result.skipped.length ? `, skipped ${result.skipped.length} you had changed` : ''}. ⌘Z undoes it.`)
      return
    }
    if (proposal.type === 'move') {
      const result = await review({ id: proposal.id, decision: 'accept' })
      if (result.stale) { notify('The blocks or anchor changed, so this move no longer applies.'); return }
      setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'accepted' } : p) })
      const ids = proposal.blockIds ?? []
      const first = blockPosition(ids[0]), last = blockPosition(ids[ids.length - 1])
      if (!first || !last) throw new Error('Blocks disappeared. Reloading.')
      const slice = editor.state.doc.slice(first.pos, last.pos + last.size)
      let tr = editor.state.tr.delete(first.pos, last.pos + last.size)
      const anchor = (() => { let found: { pos: number; size: number } | undefined; tr.doc.descendants((node, pos) => { if (!found && node.attrs?.id === proposal.anchorBlockId) found = { pos, size: node.nodeSize }; return !found }); return found })()
      if (!anchor) throw new Error('Anchor disappeared. Reloading.')
      tr = tr.insert(proposal.placement === 'before' ? anchor.pos : anchor.pos + anchor.size, slice.content)
      editor.view.dispatch(tr)
      revision.current = result.document.revision
      dirty.current = false; setSaveState('Saved'); queueSync()
      notify('Moved. ⌘Z undoes it.')
      return
    }
    if (proposal.type === 'insert') {
      const parsed = editor.markdown?.parse(edited)
      const nodes = parsed?.content ?? []
      if (!nodes.length) throw new Error('Nothing to insert.')
      const result = await review({ id: proposal.id, decision: 'accept', nodes, markdown: edited })
      if (result.stale) { notify('The surrounding text changed, so this addition no longer applies.'); return }
      setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'accepted' } : p) })
      const anchor = blockPosition(proposal.anchorBlockId!)
      if (!anchor) throw new Error('Anchor disappeared. Reloading.')
      const inserted = (result.inserted as any[]).map(n => editor.schema.nodeFromJSON(n))
      const at = proposal.placement === 'before' ? anchor.pos : anchor.pos + anchor.size
      editor.view.dispatch(editor.state.tr.insert(at, Fragment.fromArray(inserted)))
      revision.current = result.document.revision
    } else {
      // Paragraph and heading text travels as inline Markdown; parse it here so marks survive.
      let content: any[] | undefined
      if (proposal.blockType !== 'table' && proposal.blockType !== 'codeBlock' && edited.trim()) {
        const parsed = editor.markdown?.parse(edited)
        const first = parsed?.content?.[0]
        if (first?.content?.length) content = first.content
      }
      const result = await review({ id: proposal.id, decision: 'accept', text: edited, content })
      if (result.stale) { notify('You changed this paragraph, so the suggestion no longer applies.'); return }
      const target = blockPosition(proposal.blockId!)
      if (!target) throw new Error('Target disappeared. Reloading.')
      setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'accepted' } : p) })
      if (result.removed) editor.view.dispatch(editor.state.tr.delete(target.pos, target.pos + target.size))
      else if (result.node) editor.view.dispatch(editor.state.tr.replaceWith(target.pos, target.pos + target.size, editor.schema.nodeFromJSON(result.node)))
      else {
        const fresh = result.document.json && (function find(n: any): any { if (n.attrs?.id === proposal.blockId) return n; for (const c of n.content ?? []) { const f = find(c); if (f) return f } })(result.document.json)
        const inline = (fresh?.content ?? []).map((n: any) => editor.schema.nodeFromJSON(n))
        editor.view.dispatch(editor.state.tr.replaceWith(target.pos + 1, target.pos + target.size - 1, inline))
      }
      revision.current = result.document.revision
    }
    const job = stateRef.current?.jobs.find(j => j.id === proposal.jobId)
    if (job?.directive) {
      const chip = findDirectives(editor.state.doc).find(d => d.complete && d.text === job.directive && (d.blockId === job.blockIds[0] || true))
      if (chip) {
        const before = editor.state.doc.textBetween(Math.max(chip.from - 1, 0), chip.from)
        editor.view.dispatch(editor.state.tr.delete(before === ' ' ? chip.from - 1 : chip.from, chip.to))
      }
    }
    // The mirror matches the server document; a deferred sync reconciles any drift without blocking the writer.
    dirty.current = false; setSaveState('Saved'); queueSync()
    notify(proposal.after === '' && proposal.type === 'replace' ? 'Removed. ⌘Z undoes it.' : 'Accepted. ⌘Z undoes it.')
  })
  async function acceptAll() {
    const pending = (stateRef.current?.proposals ?? []).filter(p => p.status === 'pending' && !p.stale && p.type !== 'comment')
    if (!editor || !pending.length) return
    if (readingRef.current) { notify('Stop reading before reviewing suggestions.'); return }
    const order = new Map<string, number>()
    editor.state.doc.descendants((node, pos) => { if (node.attrs?.id) order.set(node.attrs.id, pos) })
    const at = (p: Proposal) => order.get(p.type === 'insert' || p.type === 'move' ? p.anchorBlockId ?? '' : p.type === 'replace_text' ? p.edits?.[0]?.blockId ?? '' : p.blockId ?? '') ?? Number.MAX_SAFE_INTEGER
    const queue = [...pending].sort((a, b) => at(a) - at(b))
    let done = 0, failed = 0
    for (const p of queue) {
      try { await accept(p, p.type === 'insert' ? p.markdown ?? '' : p.after ?? ''); done++ } catch { failed++ }
    }
    notify(`Accepted ${done} ${done === 1 ? 'suggestion' : 'suggestions'}${failed ? `, ${failed} could not be applied` : ''}. ⌘Z steps back through them.`)
    editor.commands.focus()
  }
  async function rejectAll() {
    const pending = (stateRef.current?.proposals ?? []).filter(p => p.status === 'pending')
    if (!pending.length) return
    let done = 0
    for (const p of pending) { try { await review({ id: p.id, decision: p.type === 'comment' ? 'resolve' : 'reject' }); done++ } catch {} }
    setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => pending.some(x => x.id === p.id) ? { ...p, status: p.type === 'comment' ? 'resolved' : 'rejected' } : p) })
    void refresh()
    notify(`Dismissed ${done} ${done === 1 ? 'suggestion' : 'suggestions'}.`)
    editor?.commands.focus()
  }
  const resolve = async (proposal: Proposal) => withBusy(async () => { await review({ id: proposal.id, decision: 'resolve' }); setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'resolved' } : p) }) })
  const reply = async (proposal: Proposal, feedback: string) => withBusy(async () => { await review({ id: proposal.id, decision: 'reply', feedback }); setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'replied' } : p) }); notify('Reply sent.') })
  const parseMarkdown = (markdown: string): any[] => editor?.markdown?.parse(markdown)?.content ?? []
  const reject = async (proposal: Proposal) => withBusy(async () => { await review({ id: proposal.id, decision: 'reject' }); setState(prev => prev && { ...prev, proposals: prev.proposals.map(p => p.id === proposal.id ? { ...p, status: 'rejected' } : p) }) })
  const reconsider = async (proposal: Proposal, feedback: string) => withBusy(async () => { await flush(); await review({ id: proposal.id, decision: 'reconsider', feedback }); notify('Sent back with your note.') })
  const cancelJob = async (id: string) => { await api(docPath(docRef.current, 'cancel'), { id }); void refresh() }
  const demo = async () => { try { await flush(); await api(docPath(docRef.current, 'demo'), { blockId: currentBlockId() }); void refresh() } catch (e) { notify((e as Error).message) } }
  function locate(proposal: Proposal) {
    const id = proposal.type === 'insert' || proposal.type === 'move' ? proposal.anchorBlockId! : proposal.type === 'replace_text' ? proposal.edits?.[0]?.blockId ?? '' : proposal.blockId!
    const pos = blockPosition(id)
    if (!pos || !editor) return
    editor.commands.setTextSelection(pos.pos + 1); editor.commands.scrollIntoView()
    hostFor(proposal.id).scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  function jump(pos: number) { if (!editor) return; editor.commands.setTextSelection(pos + 1); editor.commands.scrollIntoView(); if (mode === 'editing') editor.commands.focus() }

  // Export downloads the server's Markdown (with front matter); if that route is unavailable the editor's own Markdown is used.
  async function exportMarkdown() {
    if (!editor) return
    const name = (titleRef.current?.value || 'document').replace(/[^a-z0-9 _-]/gi, '') + '.md'
    let blob: Blob
    try { await flush().catch(() => {}); blob = await apiBlob(`/api/documents/${encodeURIComponent(docRef.current)}/export.md`) }
    catch { blob = new Blob([editor.getMarkdown()], { type: 'text/markdown;charset=utf-8' }) }
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = name
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  // Import creates a new document in the current folder; front matter in the file wins over the file name.
  async function importMarkdown(file: File) {
    try {
      const markdown = await file.text()
      const doc = await lib.createDocument({ title: file.name.replace(/\.(md|markdown)$/i, ''), folder: metaRef.current?.folder ?? '/', markdown })
      notify(`Imported “${doc.title}”. Check the formatting before exporting.`)
      navigate(`/d/${doc.id}`)
    } catch (e) { notify((e as Error).message) }
  }

  // Catalogue edits: title, tags, folder and front matter go through PATCH and refresh the library tree.
  const applySummary = (s: DocumentSummary) => { setMeta(m => m && { ...m, ...s, tags: s.tags ?? m.tags }); lib.patchLocal(s.id, s) }
  const commitTitle = async (title: string) => {
    const next = title.trim() || 'Untitled'
    if (titleRef.current && titleRef.current.value !== next) titleRef.current.value = next
    if (!metaRef.current || metaRef.current.title === next) return
    try { applySummary(await lib.update(docRef.current, { title: next })) } catch (e) { notify((e as Error).message) }
  }
  const onTitleInput = () => { dirty.current = true; queueSync(); if (titleRef.current) lib.patchLocal(docRef.current, { title: titleRef.current.value }) }
  const setTags = async (tags: string[]) => { applySummary(await lib.update(docRef.current, { tags })); void loadMeta() }
  const moveTo = async (folder: string) => { applySummary(await lib.update(docRef.current, { folder: normaliseFolder(folder) })); notify(`Moved to ${normaliseFolder(folder)}.`) }
  const saveFrontmatter = async (frontmatter: Record<string, unknown>) => {
    const summary = await lib.update(docRef.current, { frontmatter })
    applySummary(summary)
    if (titleRef.current && summary.title && document.activeElement !== titleRef.current) titleRef.current.value = summary.title
    await loadMeta(); notify('Properties saved.')
  }

  function onEditorUpdate() {
    if (!editor || !sessionId || readingRef.current) return
    const fresh = findDirectives(editor.state.doc).filter(d => d.complete && d.text && !firedDirectives.current.has(directiveKey(d)))
    for (const d of fresh) {
      firedDirectives.current.add(directiveKey(d))
      localDirectives.current.set(directiveKey(d), 'queued')
      const current = directivesPluginKey.getState(editor.state) ?? new Map()
      editor.view.dispatch(editor.state.tr.setMeta(directivesPluginKey, new Map([...current, [directiveKey(d), 'queued']])).setMeta('addToHistory', false))
      void (async () => {
        try {
          clearTimeout(pendingSync.current); pendingSync.current = undefined
          await sync().catch(() => {})
          await api(docPath(docRef.current, 'jobs'), { instruction: d.text, blockIds: [d.blockId], sessionId, context: { tk: d.text, inline: d.inline } })
          void refresh()
        } catch (e) { firedDirectives.current.delete(directiveKey(d)); localDirectives.current.delete(directiveKey(d)); notify((e as Error).message) }
      })()
    }
  }
  function onContextMenu(event: React.MouseEvent) {
    if (!editor || !(event.target as HTMLElement).closest('.tiptap')) return
    if ((event.target as HTMLElement).closest('.suggestion-host')) return
    event.preventDefault()
    const { from, to } = editor.state.selection
    const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
    setMenu({ x: event.clientX, y: event.clientY, selection: from !== to ? editor.state.doc.textBetween(from, to, ' ').trim() : '', blockId: currentBlockId(), pos: hit ? (hit.inside >= 0 ? hit.inside : hit.pos) : undefined })
  }
  const menuItems: MenuItem[] = menu ? (() => {
    const connected = (state?.sessions ?? []).some(s => s.connected)
    const hasSelection = Boolean(menu.selection)
    const copy = () => { try { document.execCommand('copy') } catch {} }
    const readItem: MenuItem = readingRef.current
      ? { icon: <Pause size={14} />, iconClass: 'reading', label: 'Stop reading', onSelect: () => player.stop() }
      : { icon: <Play size={14} />, iconClass: 'reading', label: 'Read from here', disabled: agentActive, title: agentActive ? AGENT_BUSY : undefined, onSelect: () => startReading(menu.pos) }
    if (mode !== 'editing') return [readItem, { separator: true, label: '' }, { icon: <Copy size={14} />, label: 'Copy', hint: '⌘C', disabled: !hasSelection, onSelect: copy }]
    const cut = () => { try { document.execCommand('cut') } catch {} }
    const paste = async () => { try { const text = await navigator.clipboard.readText(); if (text) editor!.chain().focus().insertContent(text).run() } catch { notify('Paste with ⌘V; the browser blocked clipboard access.') } }
    const proofreadBlock = async () => {
      if (!menu.blockId) return
      try {
        await flush()
        const pos = blockPosition(menu.blockId)
        const $pos = pos ? editor!.state.doc.resolve(pos.pos) : undefined
        let table: { ids: string[] } | undefined
        for (let d = $pos?.depth ?? 0; d > 0; d--) { const n = $pos!.node(d); if (n.type.name === 'table') { const ids: string[] = [n.attrs.id]; n.descendants(c => { if (c.type.name === 'paragraph' && c.attrs.id) ids.push(c.attrs.id) }); table = { ids } } }
        await api(docPath(docRef.current, 'jobs'), { instruction: table ? PROOFREAD_TABLE_INSTRUCTION : PROOFREAD_INSTRUCTION, blockIds: table ? table.ids : [menu.blockId], sessionId, kind: 'proofread', context: table ? { table: true } : undefined })
        void refresh()
      } catch (e) { notify((e as Error).message) }
    }
    return [
      readItem,
      { separator: true, label: '' },
      { icon: <Sparkles size={14} />, iconClass: 'agent', label: hasSelection ? 'Ask agent about this' : 'Ask agent…', hint: '⌘K', disabled: !connected, title: readingRef.current ? 'Held until you stop reading' : undefined, onSelect: () => openCommand('', menu.selection || undefined) },
      { icon: <Check size={14} />, label: 'Proofread this', disabled: !connected || !menu.blockId || readingRef.current, title: readingRef.current ? 'Paused while reading aloud' : undefined, onSelect: () => void proofreadBlock() },
      { separator: true, label: '' },
      { icon: <Bold size={14} />, label: 'Bold', hint: '⌘B', onSelect: () => runAction(editor!, 'bold') },
      { icon: <span className="menu-glyph-italic">I</span>, label: 'Italic', hint: '⌘I', onSelect: () => runAction(editor!, 'italic') },
      { icon: view?.flags.h2 ? <Type size={14} /> : <Heading2 size={14} />, label: view?.flags.h2 ? 'Normal text' : 'Heading', onSelect: () => runAction(editor!, view?.flags.h2 ? 'paragraph' : 'h2') },
      { icon: <Table size={14} />, label: 'Insert table', onSelect: () => runAction(editor!, 'table') },
      { separator: true, label: '' },
      { icon: <Scissors size={14} />, label: 'Cut', hint: '⌘X', disabled: !hasSelection, onSelect: cut },
      { icon: <Copy size={14} />, label: 'Copy', hint: '⌘C', disabled: !hasSelection, onSelect: copy },
      { icon: <Clipboard size={14} />, label: 'Paste', hint: '⌘V', onSelect: () => void paste() },
    ]
  })() : []

  live.current = { openCommand, executeSlash, accept, currentBlockId, currentBlockChain, onUpdate: onEditorUpdate, docChanged: () => player.clear(), flushHeld, showUtterance, editor: () => editor, openDocument: id => navigate(`/d/${id}`) }

  if (!editor) return null

  const pending = state?.proposals.filter(p => p.status === 'pending') ?? []
  const sessions = state?.sessions ?? []
  const slashPosition = slashOpen ? (() => { const c = editor.view.coordsAtPos(view!.from); return { top: Math.min(c.bottom + 8, window.innerHeight - 360), left: Math.min(c.left, window.innerWidth - 360) } })() : null
  const connected = sessions.some(s => s.connected)
  const working = state?.activity.length ?? 0
  const playerProps = { snapshot: reading, disabled: agentActive, disabledReason: AGENT_BUSY, onPlay: () => reading.status === 'paused' ? player.play() : startReading(), onPause: () => player.pause(), onStop: () => player.stop(), onSpeed: (s: number) => player.setSpeed(s) }

  return (
    <>
      <AppBar user={user}
        middle={<div className="connection"><span className={`dot ${connected ? 'connected' : ''} ${working ? 'working' : ''}`} /><span>{connectionLabel}</span><span className="meta-divider" /><span className="save-state">{saveState}</span></div>}
        actions={<>
          <div className="segmented" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={mode === 'editing'} className={mode === 'editing' ? 'on' : ''} onClick={() => setMode('editing')}>Editing</button>
            <button role="radio" aria-checked={mode === 'reading'} className={mode === 'reading' ? 'on' : ''} onClick={() => setMode('reading')}>Reading</button>
          </div>
          <label className="quiet file-button" title="Import a Markdown file as a new document"><Upload size={14} aria-hidden /> Import .md<input type="file" accept=".md,.markdown,text/markdown,text/plain" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importMarkdown(f); e.target.value = '' }} /></label>
          <button className="quiet" onClick={() => void exportMarkdown()} title="Download this document as Markdown with front matter"><Download size={14} aria-hidden /> Export</button>
        </>}
      />
      <div className="workspace">
        <LibraryColumn currentId={docId} outline={{ headings: view?.headings ?? [], onJump: jump, words: view?.words ?? 0 }} player={playerProps} />
        <main className="writing">
          <DocumentHeader meta={meta} titleRef={titleRef} readOnly={mode !== 'editing'} onTitleInput={onTitleInput} onTitleCommit={t => void commitTitle(t)} onMove={() => setMoving(true)} onTags={setTags} onFrontmatter={saveFrontmatter} tagSuggestions={lib.tags} />
          {mode === 'editing' && <Toolbar editor={editor} flags={view?.flags ?? { bold: false, italic: false, h1: false, h2: false, h3: false, inTable: false }} disabled={busy} />}
          <div className={`page ${mode}`} ref={pageRef} onContextMenu={onContextMenu}>
            <OffscreenMarkers markers={markers} tick={tick} container={pageRef} />
            <EditorContent editor={editor} />
            <CommandBar open={command.open} anchor={command.anchor} initial={command.initial} selection={command.selection} scopeLabel={command.scopeLabel ?? (command.scopeId ? 'This paragraph' : 'Around the caret')} sessions={sessions} sessionId={sessionId} onSessionChange={setSessionId} onSubmit={submitCommand} onClose={closeCommand} />
          </div>
          <RelatedPanel meta={meta} />
          <footer className="document-footer"><span>{view?.words ?? 0} words</span><span><kbd>⌘K</kbd> ask · <kbd>/</kbd> insert · <kbd>[[</kbd> link · <kbd>⌘↵</kbd> accept the suggestion under the caret</span></footer>
        </main>
        <Rail sessions={sessions} sessionId={sessionId} onSession={setSessionId} jobs={state?.jobs ?? []} activity={state?.activity ?? []} proposals={state?.proposals ?? []} mcpUrl={mcpUrl} proofread={proofread} onProofread={on => { setProofread(on); notify(on ? 'Proofreading settled paragraphs.' : 'Proofreading paused.') }} onDemo={demo} onCancel={cancelJob} onLocate={locate} onAcceptAll={acceptAll} onRejectAll={rejectAll} busy={busy} onNotify={notify} reading={reading.status !== 'idle'} held={held} onStopReading={() => player.stop()} />
      </div>
      {pending.map(p => createPortal(<SuggestionCard key={p.id} proposal={p} session={sessions.find(s => s.id === p.sessionId)} busy={busy || reading.status !== 'idle'} parseMarkdown={parseMarkdown} onAccept={accept} onReject={reject} onReconsider={reconsider} onResolve={resolve} onReply={reply} />, hostFor(p.id), p.id))}
      <ContextMenu position={menu} items={menuItems} onClose={() => setMenu(null)} />
      {slashOpen && slashPosition && <SlashMenu query={view!.slashText} index={slashIndex} position={slashPosition} onPick={executeSlash} />}
      {moving && meta && <MoveDialog folders={lib.library?.folders ?? []} current={meta.folder} onClose={() => setMoving(false)} onMove={moveTo} />}
      {(updateReady || mermaidFailed) && <div className="update-banner" role="status">Notebook Duplex was updated while this tab was open{mermaidFailed ? ', so diagrams cannot load' : ''}. <button className="primary small" onClick={async () => { try { await flush() } catch {} location.reload() }}>Reload</button></div>}
    </>
  )
}
