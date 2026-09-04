/**
 * ReviewThread — the comments on one change (or on the request itself):
 * a tile with the comments and an always-present composer. Posting goes through the
 * review's `comment` action; the list re-renders from the server's copy.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { BranchReviewComment, ReviewUserLabel } from '@core/branches'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { UserAvatar } from '@admin/shared/UserAvatar/UserAvatar'
import { relativeIso } from './reviewFormat'
import styles from './BranchReviewPage.module.css'

interface ReviewThreadProps {
  title: ReactNode
  comments: BranchReviewComment[]
  me: ReviewUserLabel
  placeholder: string
  onPost: (body: string) => Promise<unknown>
  testId: string
}

function submitOnCmdEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}

export function ReviewThread({ title, comments, me, placeholder, onPost, testId }: ReviewThreadProps) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [posting, setPosting] = useState(false)
  const expanded = focused || text.trim().length > 0

  async function submit(): Promise<void> {
    const body = text.trim()
    if (!body || posting) return
    setPosting(true)
    try {
      await onPost(body)
      setText('')
      setFocused(false)
    } catch (err) {
      console.error('[branch-review] comment failed:', err)
      pushToast({ kind: 'error', title: 'Could not post the comment', body: getErrorMessage(err, 'Unknown review error') })
    } finally {
      setPosting(false)
    }
  }

  const count = comments.length
  return (
    <div className={styles.thread} data-testid={testId}>
      <div className={styles.threadHead}>
        <span className={styles.threadTitle}>{title}</span>
        <span className={styles.spacer} />
        <span className={styles.threadCount}>{count === 0 ? 'No comments' : `${count} ${count === 1 ? 'comment' : 'comments'}`}</span>
      </div>
      {count > 0 && (
        <div className={styles.threadItems}>
          {comments.map((comment) => (
            <div key={comment.id} className={styles.threadItem} data-testid={`${testId}-comment`}>
              <span className={styles.threadAvatar}>
                {comment.author && <UserAvatar user={comment.author} size={22} />}
              </span>
              <div>
                <div className={styles.threadItemHead}>
                  <strong>{comment.author?.displayName ?? 'Removed user'}</strong>
                  <span>{relativeIso(comment.createdAt)}</span>
                </div>
                <p className={styles.threadItemText}>{comment.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.threadComposer}>
        <div className={styles.threadComposerRow}>
          <span className={styles.threadAvatar}>
            <UserAvatar user={me} size={22} />
          </span>
          <Textarea
            fieldSize="sm"
            rows={expanded ? 3 : 1}
            placeholder={placeholder}
            value={text}
            disabled={posting}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => submitOnCmdEnter(event, () => { void submit() })}
            data-testid={`${testId}-input`}
          />
        </div>
        {expanded && (
          <div className={styles.threadComposerActions}>
            <span className={styles.threadComposerHint}>Enter with Cmd or Ctrl posts</span>
            <span className={styles.spacer} />
            <Button
              variant="ghost"
              size="xs"
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setText('')
                setFocused(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="xs"
              type="button"
              busy={posting}
              disabled={!text.trim()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { void submit() }}
              data-testid={`${testId}-submit`}
            >
              Comment
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
