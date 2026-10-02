import { useEffect, useState } from 'react'
import type React from 'react'

export type Marker = { id: string; kind: 'review' | 'working'; element: HTMLElement | null }
type Side = { review: number; working: number; nearest?: HTMLElement }

function measure(markers: Marker[]): { above: Side; below: Side } {
  const above: Side = { review: 0, working: 0 }, below: Side = { review: 0, working: 0 }
  const top = 120, bottom = window.innerHeight - 40
  let aboveDist = Infinity, belowDist = Infinity
  for (const m of markers) {
    if (!m.element?.isConnected) continue
    const rect = m.element.getBoundingClientRect()
    if (rect.bottom < top) { above[m.kind]++; if (top - rect.bottom < aboveDist) { aboveDist = top - rect.bottom; above.nearest = m.element } }
    else if (rect.top > bottom) { below[m.kind]++; if (rect.top - bottom < belowDist) { belowDist = rect.top - bottom; below.nearest = m.element } }
  }
  return { above, below }
}
const label = (s: Side) => [s.review ? `${s.review} to review` : '', s.working ? (s.working === 1 ? 'Claude working' : `Claude working ×${s.working}`) : ''].filter(Boolean).join(' · ')

export function OffscreenMarkers({ markers, tick, container }: { markers: Marker[]; tick: number; container: React.RefObject<HTMLElement | null> }) {
  const [sides, setSides] = useState(() => ({ above: { review: 0, working: 0 } as Side, below: { review: 0, working: 0 } as Side }))
  const [center, setCenter] = useState<number>()
  useEffect(() => {
    let frame = 0
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { setSides(measure(markers)); const r = container.current?.getBoundingClientRect(); if (r) setCenter(r.left + r.width / 2) }) }
    update()
    window.addEventListener('scroll', update, { passive: true }); window.addEventListener('resize', update)
    const interval = setInterval(update, 1000)
    return () => { cancelAnimationFrame(frame); clearInterval(interval); window.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [markers, tick])
  const go = (el?: HTMLElement) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const show = (s: Side) => s.review + s.working > 0
  return (
    <>
      <div className="offscreen offscreen-top" aria-live="polite" style={{ left: center }}>
        {show(sides.above) && <button className={`offscreen-pill ${sides.above.review ? 'review' : 'working'}`} onClick={() => go(sides.above.nearest)}>↑ {label(sides.above)}</button>}
      </div>
      <div className="offscreen offscreen-bottom" style={{ left: center }}>
        {show(sides.below) && <button className={`offscreen-pill ${sides.below.review ? 'review' : 'working'}`} onClick={() => go(sides.below.nearest)}>↓ {label(sides.below)}</button>}
      </div>
    </>
  )
}
