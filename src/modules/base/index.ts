/**
 * Base module registration — imports all base modules so they self-register
 * with the global registry singleton on import.
 *
 * Imported once inside `src/admin/AdminEntry.tsx` (the lazy admin chunk) so
 * the base modules + their dependencies (publisher, sanitize, page-tree
 * schemas) stay out of the eager entry bundle and don't ship to the login /
 * setup screens. Server uses the same module via `server/publish/publicRenderer.ts`.
 *
 * Order matters only for module IDs that reference each other — keep grouped by
 * picker category so new base modules land in an obvious place.
 */

// Page body (required — every new page starts with one)
import './body'

// Layout modules
import './container'
import './loop'

// Typography modules
import './text'
import './list'
import './outlet'

// Media modules
import './image'
import './svg'

// Interactive modules
import './button'
import './link'

// Form modules
import './forms'

// Media modules (extended)
import './video'

// Component system modules
import './slotInstance'
import './slotOutlet'
import './visualComponentRef'
