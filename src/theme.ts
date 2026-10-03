// Theme: light or dark, dark by default like the other DonkeyWork apps. Persisted as `donkeywork-theme`
// and applied as the `.dark` class on <html> (the token convention), with `color-scheme` kept in step.
import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'
const KEY = 'donkeywork-theme'
const listeners = new Set<() => void>()

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
}
export function applyTheme(theme = getTheme()) {
  const dark = theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light')
  for (const l of listeners) l()
}
export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme) } catch {}
  applyTheme(theme)
}
export function useTheme() {
  const [theme, set] = useState<Theme>(getTheme)
  useEffect(() => { const l = () => set(getTheme()); listeners.add(l); return () => { listeners.delete(l) } }, [])
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark'), set: setTheme }
}
