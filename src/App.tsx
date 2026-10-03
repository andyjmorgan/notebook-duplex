import { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Toaster } from 'sonner'
import { auth, type AuthStatus, type AuthUser } from './auth'
import { useTheme } from './theme'
import { LibraryProvider } from './library'
import { Notebook } from './Notebook'
import { AppBar } from './components/AppBar'
import { LibraryColumn } from './components/Library'
import { SignIn } from './pages/SignIn'
import { Home } from './pages/Home'
import { TagPage } from './pages/TagPage'
import { SearchPage } from './pages/SearchPage'

const TokensPage = lazy(() => import('./pages/TokensPage'))

function useAuth() {
  const [snapshot, setSnapshot] = useState<{ status: AuthStatus; user?: AuthUser; error: string }>({ status: auth.status, user: auth.user, error: auth.error })
  useEffect(() => { const off = auth.subscribe(() => setSnapshot({ status: auth.status, user: auth.user, error: auth.error })); void auth.start(); return off }, [])
  return snapshot
}

function DocumentRoute({ user }: { user: AuthUser }) {
  const { id = '' } = useParams()
  if (!id) return <Navigate to="/" replace />
  return <Notebook docId={id} user={user} />
}
/** Library pages that are not a document: the library column on the left, the page in the middle. */
function LibraryShell({ user, children }: { user: AuthUser; children: React.ReactNode }) {
  return (
    <>
      <AppBar user={user} />
      <div className="workspace two-column">
        <LibraryColumn />
        {children}
      </div>
    </>
  )
}
function SettingsShell({ user, children }: { user: AuthUser; children: React.ReactNode }) {
  return (
    <>
      <AppBar user={user} />
      <Suspense fallback={<main className="settings"><p className="caption">Loading…</p></main>}>{children}</Suspense>
    </>
  )
}

export function App() {
  const { status, user, error } = useAuth()
  const theme = useTheme()
  if (status !== 'signed-in' || !user) return <><SignIn status={status === 'signed-in' ? 'loading' : status} error={error} /><Toaster position="bottom-center" theme={theme.resolved} /></>
  return (
    <BrowserRouter>
      <LibraryProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/d/:id" element={<DocumentRoute user={user} />} />
          <Route path="/tags/:tag" element={<LibraryShell user={user}><TagPage /></LibraryShell>} />
          <Route path="/search" element={<LibraryShell user={user}><SearchPage /></LibraryShell>} />
          <Route path="/settings/tokens" element={<SettingsShell user={user}><TokensPage /></SettingsShell>} />
          <Route path="/auth/callback" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </LibraryProvider>
      <Toaster position="bottom-center" theme={theme.resolved} closeButton richColors={false} toastOptions={{ className: 'toast', duration: 4200 }} />
    </BrowserRouter>
  )
}
