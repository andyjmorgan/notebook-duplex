import type { Describe, Utterance } from './script'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused'
export type PlayerSnapshot = { status: PlayerStatus; index: number; total: number; speed: number }
export const SPEEDS = [0.75, 1, 1.3, 1.5]
const LOOKAHEAD = 3

type Deps = {
  tts: (text: string) => Promise<Blob>
  describe: (d: Describe) => Promise<string>
  onChange: (snapshot: PlayerSnapshot) => void
  onUtterance: (utterance: Utterance | null) => void
  onError: (message: string) => void
}

// Plays a narration script back to back: resolves descriptions, fetches audio a few utterances ahead,
// and reports which utterance is sounding so the document can highlight it. Speed is playbackRate, so
// changing it never refetches audio.
export class ReadAloudPlayer {
  private audio = new Audio()
  private script: Utterance[] = []
  private index = 0
  private status: PlayerStatus = 'idle'
  speed = 1
  private clips = new Map<string, Promise<string>>()
  private texts = new Map<string, Promise<string>>()
  private token = 0
  private resume: (() => void) | undefined
  constructor(private deps: Deps) { this.audio.preload = 'auto' }

  snapshot(): PlayerSnapshot { return { status: this.status, index: this.index, total: this.script.length, speed: this.speed } }
  get active() { return this.status !== 'idle' }
  private set(status: PlayerStatus) { this.status = status; this.deps.onChange(this.snapshot()) }

  start(script: Utterance[], index = 0) {
    this.halt()
    this.script = script; this.index = Math.min(index, script.length - 1)
    for (const u of script.slice(this.index).filter(u => u.describe).slice(0, 4)) void this.textFor(u).catch(() => {})
    void this.run(this.index)
  }
  play() {
    if (this.status !== 'paused') return
    if (this.resume) { const r = this.resume; this.resume = undefined; this.set('loading'); r() }
    else if (this.audio.src && !this.audio.ended) { this.set('playing'); void this.audio.play().catch(() => {}) }
    else this.set('loading') // a clip is still being fetched; the loop continues when it lands
  }
  pause() { if (this.status === 'playing' || this.status === 'loading') { this.audio.pause(); this.set('paused') } }
  stop() { this.halt(); this.script = []; this.index = 0; this.set('idle'); this.deps.onUtterance(null) }
  // Edits empty the recording: no script, no cached audio, no highlight.
  clear() { this.halt(); this.script = []; this.index = 0; for (const p of this.clips.values()) p.then(url => URL.revokeObjectURL(url), () => {}); this.clips.clear(); this.texts.clear(); this.set('idle'); this.deps.onUtterance(null) }
  setSpeed(speed: number) { this.speed = speed; this.audio.playbackRate = speed; this.deps.onChange(this.snapshot()) }
  private halt() { this.token++; this.resume = undefined; this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load() }

  private textFor(u: Utterance): Promise<string> {
    if (u.text) return Promise.resolve(u.text)
    const key = `${u.describe!.kind}|${u.describe!.language}|${u.describe!.source}`
    let p = this.texts.get(key)
    if (!p) { p = this.deps.describe(u.describe!).then(text => { u.text = text; return text }); this.texts.set(key, p); p.catch(() => this.texts.delete(key)) }
    return p
  }
  private clipFor(text: string): Promise<string> {
    let p = this.clips.get(text)
    if (!p) { p = this.deps.tts(text).then(blob => URL.createObjectURL(blob)); this.clips.set(text, p); p.catch(() => this.clips.delete(text)) }
    return p
  }
  private audioFor(u: Utterance) { return this.textFor(u).then(text => this.clipFor(text)) }

  private async run(start: number) {
    const my = ++this.token
    let failures = 0
    for (let i = start; i < this.script.length; i++) {
      this.index = i
      this.set('loading')
      this.deps.onUtterance(this.script[i])
      const current = this.audioFor(this.script[i])
      for (let j = i + 1; j <= i + LOOKAHEAD && j < this.script.length; j++) void this.audioFor(this.script[j]).catch(() => {})
      let url: string
      try { url = await current } catch (e) {
        if (my !== this.token) return
        if (++failures >= 3) { this.deps.onError((e as Error).message || 'Text to speech is unavailable.'); this.stop(); return }
        continue
      }
      if (my !== this.token) return
      if (this.status === 'paused') await new Promise<void>(r => { this.resume = r })
      if (my !== this.token) return
      failures = 0
      const played = await new Promise<boolean>(resolve => {
        const ac = new AbortController()
        const finish = (ok: boolean) => { ac.abort(); resolve(ok) }
        this.audio.addEventListener('ended', () => finish(true), { signal: ac.signal })
        this.audio.addEventListener('error', () => finish(false), { signal: ac.signal })
        this.audio.src = url; this.audio.playbackRate = this.speed
        this.set('playing')
        this.audio.play().catch(e => { if (my === this.token) this.deps.onError(e.name === 'NotAllowedError' ? 'The browser blocked audio. Click Play again.' : e.message); finish(false) })
      })
      if (my !== this.token) return
      if (!played) { this.audio.removeAttribute('src'); this.audio.load() }
    }
    if (my === this.token) { this.index = 0; this.set('idle'); this.deps.onUtterance(null) }
  }
}
