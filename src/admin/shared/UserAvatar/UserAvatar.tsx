/**
 * UserAvatar — circular avatar with `<img>` rendering and an initials
 * fallback. Used everywhere a user identity surfaces in the admin shell
 * (toolbar trigger, Account → Profile, account dropdown header).
 *
 * Rendering precedence:
 *   1. Uploaded avatar image (`user.avatarUrl`)
 *   2. Gravatar identicon URL built from `user.gravatarHash` (always exists
 *      for authenticated users, deterministic per email)
 *   3. Initials letter circle (final fallback, used when the image fails to
 *      load — `<img onError>` flips the state — or both URLs are absent)
 *
 * The size in CSS pixels is the only knob callers need to set. We hand it
 * through to `gravatarUrl` so Gravatar serves an appropriately-sized image
 * (with a 2× factor for retina), and to the CSS module via the
 * `--avatar-size` custom property so border radius, font size, and box
 * dimensions all derive from one source of truth.
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { resolveAvatarUrl } from '@core/users/avatar'
import { cn } from '@ui/cn'
import { userDisplayLabel } from '@core/users/displayName'
import styles from './UserAvatar.module.css'

interface UserAvatarProps {
  user: Pick<CmsCurrentUser, 'avatarUrl' | 'gravatarHash' | 'displayName' | 'email'>
  /** Rendered diameter in CSS pixels — must be > 0. */
  size: number
  /**
   * Optional accessible label. Defaults to `Avatar for <displayName | email>`
   * — pass null to mark the avatar as decorative when there's a separate
   * label already (e.g. inside a labelled button).
   */
  alt?: string | null
  className?: string
}

function deriveInitial(user: { displayName: string; email: string }): string {
  const source = userDisplayLabel(user).trim()
  if (!source) return '?'
  return source[0]?.toUpperCase() ?? '?'
}

export function UserAvatar({ user, size, alt, className }: UserAvatarProps): ReactNode {
  const [imageFailed, setImageFailed] = useState(false)
  const url = resolveAvatarUrl(user, { size })
  const showImage = url !== null && !imageFailed
  const displayName = userDisplayLabel(user)
  const altText = alt === null ? '' : alt ?? `Avatar for ${displayName}`

  const style: CSSProperties = { '--avatar-size': `${size}px` } as CSSProperties

  return (
    <span className={cn(styles.root, className)} style={style} aria-hidden={alt === null || undefined}>
      {showImage ? (
        <img
          className={styles.image}
          src={url}
          alt={altText}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className={styles.initials}>{deriveInitial(user)}</span>
      )}
    </span>
  )
}
