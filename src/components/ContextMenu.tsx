import { useEffect, useRef } from 'react'

export type MenuItem = { label: string; hint?: string; icon?: string; disabled?: boolean; danger?: boolean; separator?: boolean; onSelect?: () => void }
export function ContextMenu({ position, items, onClose }: { position: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!position) return
    const close = (e: Event) => { if (e instanceof KeyboardEvent && e.key !== 'Escape') return; if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return; onClose() }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close); window.addEventListener('scroll', onClose, { passive: true, once: true }); window.addEventListener('blur', onClose)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('scroll', onClose); window.removeEventListener('blur', onClose) }
  }, [position, onClose])
  useEffect(() => {
    if (!position || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    ref.current.style.left = Math.min(position.x, window.innerWidth - r.width - 8) + 'px'
    ref.current.style.top = Math.min(position.y, window.innerHeight - r.height - 8) + 'px'
  }, [position, items])
  if (!position) return null
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: position.x, top: position.y }}>
      {items.map((item, i) => item.separator ? <div key={i} className="menu-separator" role="separator" /> : (
        <button key={i} role="menuitem" className={`menu-item ${item.danger ? 'danger' : ''}`} disabled={item.disabled} onMouseDown={e => e.preventDefault()} onClick={() => { item.onSelect?.(); onClose() }}>
          <span className="menu-icon" aria-hidden>{item.icon ?? ''}</span><span>{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}
