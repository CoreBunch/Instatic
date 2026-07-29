/**
 * PeerAvatar — one admin's presence avatar: the shared `UserAvatar`
 * (upload → Gravatar → initials) inside a ring of the peer's deterministic
 * identity color. The ONE avatar look for every presence surface — the
 * toolbar stack, the live cursor, the selection name tag — so a person is
 * recognizably the same everywhere.
 *
 * Spreads rest props onto the root span so the `Tooltip` primitive (which
 * composes mouse handlers onto its trigger child) works out of the box.
 */
import type { CSSProperties, HTMLAttributes } from 'react'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { cn } from '@ui/cn'
import type { EditorPresence } from './awarenessState'
import styles from './PeerAvatar.module.css'

interface PeerAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  user: EditorPresence['user']
  /** Avatar diameter in CSS px — the identity ring wraps around it. */
  size: number
  /** Drop the identity ring (e.g. inside an already peer-colored badge). */
  ring?: boolean
}

export function PeerAvatar({ user, size, ring = true, className, style, ...rest }: PeerAvatarProps) {
  return (
    <span
      {...rest}
      className={cn(styles.avatar, ring && styles.ring, className)}
      style={{ ...style, '--peer-color': user.color } as CSSProperties}
      data-peer-avatar="true"
    >
      <UserAvatar
        user={{
          avatarUrl: user.avatarUrl,
          // Empty string = "no hash" to resolveAvatarUrl → initials fallback.
          gravatarHash: user.gravatarHash ?? '',
          displayName: user.name,
          email: user.name,
        }}
        size={size}
        alt={null}
      />
    </span>
  )
}
