import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './style.css'
import { createRoot } from 'react-dom/client'
import { applyTheme } from './theme'
import { App } from './App'
applyTheme()
createRoot(document.getElementById('app')!).render(<App />)
