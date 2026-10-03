import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '../auth'
import { UserMenu } from './UserMenu'

export function Brand({ large = false }: { large?: boolean }) {
  return <span className={`logo ${large ? 'large' : ''}`} aria-hidden>N</span>
}
/** The top bar every page shares: brand on the left, page-specific middle and actions, the user menu on the right. */
export function AppBar({ user, middle, actions }: { user: AuthUser | undefined; middle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="appbar">
      <Link className="brand" to="/"><Brand /><span>Notebook Duplex</span></Link>
      {middle ?? <span />}
      <div className="header-actions">
        {actions}
        {user && <UserMenu user={user} />}
      </div>
    </header>
  )
}
