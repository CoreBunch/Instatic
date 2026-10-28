import { useState } from 'react'

/**
 * Whether the upload queue window is open.
 *
 * The queue is genuinely stateful — it stays open after a transfer completes
 * (the user dismisses it) and the toolbar button toggles it — so it can't be
 * derived from the queue. What it does follow is one transition: an upload
 * STARTING opens it. Nothing reopens it after that, so a user who closes it
 * mid-transfer gets to keep it closed; closing hides the transfer, it does
 * not cancel it.
 *
 * The transition is detected during render, against the last `active` this
 * hook saw, rather than in an effect. The effect this replaces depended on
 * the open state as well, so every close re-ran it while an upload was in
 * flight and it opened the window straight back up.
 */
export function useUploadQueueWindow(active: boolean): {
  open: boolean
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void
} {
  const [open, setOpen] = useState(active)
  const [seenActive, setSeenActive] = useState(active)
  if (active !== seenActive) {
    setSeenActive(active)
    if (active) setOpen(true)
  }
  return { open, setOpen }
}
