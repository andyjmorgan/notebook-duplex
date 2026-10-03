// Theme: system / light / dark, persisted in localStorage. Applies the `.dark` class on <html>
// (the DonkeyWork token convention) and keeps `color-scheme` in step so native controls follow.
import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'notebook-duplex.theme'
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
const listeners = new Set<() => void>()

export function getThemeChoice(): ThemeChoice {
  try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark' || v === 'system') return v } catch {}
  return 'system'
}
export function resolvedTheme(choice = getThemeChoice()): 'light' | 'dark' {
  if (choice === 'system') return media?.matches ? 'dark' : 'light'
  return choice
}
export function applyTheme(choice = getThemeChoice()) {
  const dark = resolvedTheme(choice) === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light')
  for (const l of listeners) l()
}
export function setThemeChoice(choice: ThemeChoice) {
  try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice) } catch {}
  applyTheme(choice)
}
media?.addEventListener('change', () => { if (getThemeChoice() === 'system') applyTheme() })

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice)
  const [resolved, setResolved] = useState(resolvedTheme)
  useEffect(() => { const l = () => { setChoice(getThemeChoice()); setResolved(resolvedTheme()) }; listeners.add(l); return () => { listeners.delete(l) } }, [])
  return { choice, resolved, set: setThemeChoice }
}
