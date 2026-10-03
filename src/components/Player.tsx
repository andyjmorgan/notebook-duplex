import { Pause, Play, Square } from 'lucide-react'
import { SPEEDS, type PlayerSnapshot } from '../reading/player'

export type PlayerProps = {
  snapshot: PlayerSnapshot
  disabled: boolean; disabledReason?: string
  onPlay: () => void; onPause: () => void; onStop: () => void; onSpeed: (speed: number) => void
}

export function Player({ snapshot, disabled, disabledReason, onPlay, onPause, onStop, onSpeed }: PlayerProps) {
  const { status, index, total, speed } = snapshot
  const sounding = status === 'playing' || status === 'loading'
  const done = total ? (index + (status === 'idle' ? 0 : 1)) / total * 100 : 0
  return (
    <div className={`player ${status}`} aria-label="Read aloud" title={disabled ? disabledReason : undefined}>
      <div className="player-row">
        <button type="button" className="player-main" disabled={disabled && !sounding} aria-label={sounding ? 'Pause reading' : status === 'paused' ? 'Resume reading' : 'Read aloud'} title={disabled && !sounding ? disabledReason : sounding ? 'Pause' : status === 'paused' ? 'Resume' : 'Read the document aloud'} onClick={sounding ? onPause : onPlay}>{sounding ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />}</button>
        <button type="button" className="player-stop" disabled={status === 'idle'} aria-label="Stop reading" title="Stop" onClick={onStop}><Square size={11} aria-hidden /></button>
        <span className="player-position" aria-live="off">{status === 'idle' ? 'Read aloud' : `${Math.min(index + 1, total)} / ${total}`}</span>
        <select className="player-speed" aria-label="Reading speed" value={speed} onChange={e => onSpeed(Number(e.target.value))}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select>
      </div>
      <div className="player-progress" aria-hidden><span style={{ width: `${done}%` }} /></div>
    </div>
  )
}
