import { useEffect, useRef, useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { folderName } from '../library'

/** A small modal prompt (rename, new folder). Enter submits, Escape cancels. */
export function PromptDialog({ title, label, initial = '', placeholder, submitLabel = 'Save', onSubmit, onClose }: { title: string; label: string; initial?: string; placeholder?: string; submitLabel?: string; onSubmit: (value: string) => Promise<void> | void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector('input')?.select() }, [])
  const submit = async () => { if (!value.trim() || busy) return; setBusy(true); try { await onSubmit(value.trim()); onClose() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={e => { e.preventDefault(); onClose() }}>
      <form className="dialog-body" onSubmit={e => { e.preventDefault(); void submit() }}>
        <h2>{title}</h2>
        <label className="field-label">{label}<input value={value} placeholder={placeholder} onChange={e => setValue(e.target.value)} aria-label={label} /></label>
        {error && <p className="gate-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!value.trim() || busy}>{submitLabel}</button></div>
      </form>
    </dialog>
  )
}

/** Pick a folder for a document. Lists every known folder and lets the writer type a new path. */
export function MoveDialog({ folders, current, onMove, onClose }: { folders: string[]; current: string; onMove: (folder: string) => Promise<void> | void; onClose: () => void }) {
  const [choice, setChoice] = useState(current)
  const [custom, setCustom] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  const all = Array.from(new Set(['/', ...folders])).sort()
  const target = custom.trim() ? custom.trim() : choice
  const submit = async () => { if (busy) return; setBusy(true); try { await onMove(target); onClose() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={e => { e.preventDefault(); onClose() }}>
      <form className="dialog-body" onSubmit={e => { e.preventDefault(); void submit() }}>
        <h2>Move to folder</h2>
        <div className="folder-list" role="listbox" aria-label="Folders">
          {all.map(f => <button type="button" key={f} role="option" aria-selected={!custom && choice === f} className={`folder-option ${!custom && choice === f ? 'on' : ''}`} onClick={() => { setChoice(f); setCustom('') }}>{choice === f && !custom ? <FolderOpen size={16} aria-hidden /> : <Folder size={16} aria-hidden />}<span>{f === '/' ? 'Library (root)' : f}</span><span className="caption">{f === '/' ? '' : folderName(f)}</span></button>)}
        </div>
        <label className="field-label">Or a new folder path<input value={custom} placeholder="/projects/lab" onChange={e => setCustom(e.target.value)} aria-label="New folder path" /></label>
        {error && <p className="gate-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="quiet" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || target === current}>Move here</button></div>
      </form>
    </dialog>
  )
}
