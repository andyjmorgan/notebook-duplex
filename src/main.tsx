import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import './style.css'
import { createRoot } from 'react-dom/client'
import { applyTheme } from './theme'
import { App } from './App'
applyTheme()
createRoot(document.getElementById('app')!).render(<App />)
