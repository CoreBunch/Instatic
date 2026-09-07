/**
 * Live canvas — renders the active entry inside its real template + site
 * CSS bundle via a sandboxed iframe, with the body region wired to a
 * Tiptap editor mounted directly inside the iframe's document.
 *
 * Flow:
 *   1. Fetch the rendered entry HTML from
 *      `POST /admin/api/cms/data/rows/:id/preview` with the current draft
 *      cells. The server runs the same `publishPage` pipeline as the
 *      public route, so what shows up in the iframe matches what visitors
 *      would see on the published page.
 *   2. Inject the HTML via `iframe.srcdoc`. The iframe inherits the
 *      parent's origin for relative-URL resolution, so `/_instatic/css/…`,
 *      `/_instatic/assets/…`, `/uploads/…` all resolve and get proxied as
 *      usual in dev.
 *   3. After the iframe loads, find the body region marker
 *      (`[data-instatic-content-region]` emitted by `base.outlet`) inside
 *      `iframe.contentDocument` and instantiate a fresh Tiptap editor
 *      against that element. ProseMirror handles cross-document mounts
 *      naturally as long as the host element belongs to the target
 *      document.
 *   4. The editor's `onUpdate` fires `onBodyChange` (same contract as
 *      the Write canvas). When the parent's `body` prop changes from a
 *      non-editor source (e.g. someone pastes from the right rail), we
 *      call `editor.commands.setContent` to resync.
 *   5. The three editor menus (block-gutter "+", inline format bubble,
 *      media node toolbar) are rendered in the *host* document but
 *      configured to position themselves over the iframe's contents.
 *      Each takes the iframe element as a prop and uses floating-ui's
 *      virtual reference to translate iframe-viewport coords into
 *      host-viewport coords. From the user's perspective the entire
 *      editing experience is identical to Write mode — only the
 *      surrounding template chrome differs.
 *   6. Title / SEO / featured-media edits re-fetch the preview HTML
 *      after a short debounce. That requires destroying + re-creating
 *      the iframe-resident editor; the body markdown is the source of
 *      truth so the editor restarts with the up-to-date doc.
 */

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type SyntheticEvent,
} from 'react'
import { Editor, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { TextAlign } from '@tiptap/extension-text-align'
import { SkeletonBlock } from '@ui/components/Skeleton'
import type { DataTable, DataRow } from '@core/data/schemas'
import {
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from '@core/markdown/markdownDocument'
import { MediaNode, type MediaAttributes } from '@content/nodes/MediaNode'
import type { TiptapBodyEditorHandle } from '@content/TiptapBodyEditor'
import { previewCmsDataRow } from '@core/persistence/cmsData'
import { BodyBubbleMenu } from '../BodyBubbleMenu/BodyBubbleMenu'
import { BodyFloatingMenu } from '../BodyFloatingMenu/BodyFloatingMenu'
import { MediaNodeToolbar } from '../MediaNodeToolbar/MediaNodeToolbar'
import styles from './LiveCanvas.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const FETCH_DEBOUNCE_MS = 350

/**
 * CSS injected into the iframe's document right after the editor mounts.
 * Three responsibilities:
 *   1. Kill the default browser focus outline that the published page's
 *      reset doesn't override — `contenteditable` regions normally pick
 *      up a thick `outline: 2px auto -webkit-focus-ring-color` halo when
 *      focused, which looks foreign and disruptive inside the template.
 *   2. Give empty editable blocks (p / h1-h6 / blockquote / li) a
 *      visible `min-height` so newly-inserted blocks aren't invisible —
 *      the published site's CSS doesn't model empty editable content
 *      and would otherwise collapse them to 0px.
 *   3. Surface the Placeholder extension's hint via `.is-empty::before`
 *      so an empty block under the caret reads "Heading" / "Start
 *      writing…" — discoverability parity with Write mode.
 */
const IFRAME_EDITOR_STYLE = `
  [data-instatic-content-region]:focus,
  [data-instatic-content-region]:focus-visible,
  [data-instatic-content-region] *:focus,
  [data-instatic-content-region] *:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }
  /* The trailing-break sentinel is what ProseMirror inserts at the
   * end of every empty block so the caret has somewhere to land —
   * AND, critically, so view.coordsAtPos can return real coords for
   * that block. We must NOT hide it: the gutter "+" button reads
   * those coords, and a hidden sentinel returns {0,0,0,0} which
   * puts the button in the page top-left corner. We just neutralise
   * its layout impact instead. */
  [data-instatic-content-region] .ProseMirror-trailingBreak {
    user-select: none;
  }

  /* The published site's CSS doesn't model empty editable blocks —
   * an empty <p>, <h2>, <h3>, or <h4> collapses to height 0 and the
   * user sees nothing. Force a visible min-height so blocks newly
   * inserted via the bubble menu (paragraph / heading) show up with
   * a clickable space the cursor can land in. The values are derived
   * from each tag's typical line-height; tweaking them in absolute em
   * keeps us font-size agnostic. */
  [data-instatic-content-region] .ProseMirror p,
  [data-instatic-content-region] .ProseMirror h1,
  [data-instatic-content-region] .ProseMirror h2,
  [data-instatic-content-region] .ProseMirror h3,
  [data-instatic-content-region] .ProseMirror h4,
  [data-instatic-content-region] .ProseMirror h5,
  [data-instatic-content-region] .ProseMirror h6,
  [data-instatic-content-region] .ProseMirror blockquote,
  [data-instatic-content-region] .ProseMirror li {
    min-height: 1em;
  }

  /* Placeholder shown by Tiptap's Placeholder extension on the empty
   * block the caret is currently in. The extension marks that block
   * with the is-empty class and data-placeholder attribute; we
   * render the attribute via ::before so the user sees a hint
   * (e.g., Heading, Start writing) inside the empty block. */
  [data-instatic-content-region] .ProseMirror .is-empty::before {
    content: attr(data-placeholder);
    pointer-events: none;
    float: left;
    height: 0;
    color: rgba(127, 127, 127, 0.55);
  }
`

/**
 * Walk every stylesheet in the iframe document and append a relaxed
 * twin rule for every selector whose LAST combinator is `>` — replacing
 * that combinator with descendant whitespace so the rule still matches
 * once Tiptap's `<div class="ProseMirror">` sits between the original
 * parent and the styled element.
 *
 * Only the LAST `>` is relaxed; the outer ancestry stays direct-child
 * so we don't accidentally over-broaden a rule like
 * `body > article > article > p` into matching arbitrary `body p`
 * descendants in unrelated parts of the document.
 *
 * Skips:
 *   - non-CSSStyleRule entries (media queries, font-face, etc.)
 *     — those don't have a flat `selectorText`. We could recurse into
 *     CSSMediaRule's child rules but the marginal coverage isn't
 *     worth the complexity for v1.
 *   - cross-origin stylesheets where `cssRules` throws — same-origin
 *     iframe is the common case but third-party fonts etc. trip this.
 */
function relaxLastChildCombinators(doc: Document): void {
  // `CSSStyleRule.type` is the legacy numeric discriminator (= 1) for
  // style rules. We can't use `instanceof CSSStyleRule` here — the
  // iframe is a different realm, so its DOM objects are instances of
  // the *iframe's* CSSStyleRule constructor, not the host's, and
  // `instanceof` cross-realm always returns false.
  const STYLE_RULE_TYPE = 1
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      // Cross-origin stylesheet — skip silently.
      continue
    }
    // Snapshot the rules first; we're going to insert into the sheet
    // as we iterate and `cssRules` is live.
    const snapshot: CSSStyleRule[] = []
    for (const rule of Array.from(rules)) {
      if (rule.type === STYLE_RULE_TYPE) snapshot.push(rule as CSSStyleRule)
    }
    for (const rule of snapshot) {
      const selectors = rule.selectorText.split(',').map((s) => s.trim())
      const relaxed = selectors
        .map(relaxLastChildCombinator)
        .filter((s): s is string => s !== null)
      if (relaxed.length === 0) continue
      const relaxedSelector = relaxed.join(', ')
      const declarations = rule.style.cssText
      if (!declarations) continue
      try {
        sheet.insertRule(`${relaxedSelector} { ${declarations} }`, sheet.cssRules.length)
      } catch {
        // Some browsers reject pseudo-class combinations in
        // insertRule that they'd accept in a parsed stylesheet —
        // ignore and continue.
      }
    }
  }
}

function relaxLastChildCombinator(selector: string): string | null {
  const idx = selector.lastIndexOf('>')
  if (idx === -1) return null
  // Eat surrounding whitespace around the `>` and replace with a
  // single space so the result is a clean descendant combinator.
  let start = idx
  while (start > 0 && selector[start - 1] === ' ') start--
  let end = idx + 1
  while (end < selector.length && selector[end] === ' ') end++
  return `${selector.slice(0, start)} ${selector.slice(end)}`
}

/**
 * Backstop Enter binding for the iframe-mounted editor.
 *
 * In Write mode, Tiptap's default StarterKit keymap handles Enter
 * (it falls through to ProseMirror's `splitBlock` command). Inside
 * the iframe, however, the browser's native contenteditable Enter
 * handling — combined with whatever scripts the published page runs —
 * can intercept the event before ProseMirror's keymap plugin has a
 * chance to react: the cursor visually jumps to a fresh DOM line, but
 * no transaction gets dispatched and the ProseMirror state stays
 * unchanged. Registering an explicit Enter binding through Tiptap's
 * own keyboard-shortcut API guarantees the split command runs even
 * when the default keymap path goes quiet.
 *
 * Shift+Enter still falls through to the default hard-break behaviour
 * because we don't bind it here.
 */
const EnterForceSplit = Extension.create({
  name: 'liveCanvasEnterForceSplit',
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => editor.chain().focus().splitBlock().run(),
    }
  },
})

export interface LiveCanvasProps {
  entry: DataRow
  collection: DataTable | null
  title: string
  body: string
  readOnly: boolean
  editorRef: Ref<TiptapBodyEditorHandle>
  onBodyChange: (markdown: string) => void
  onPickMedia: () => void
  onInsertDataToken: () => void
}

interface PreviewState {
  status: 'loading' | 'ready' | 'error'
  html: string
  error: string | null
}

export function LiveCanvas({
  entry,
  title,
  body,
  readOnly,
  editorRef,
  onBodyChange,
  onPickMedia,
  onInsertDataToken,
}: LiveCanvasProps) {
  // Both the iframe element and the live editor instance live in
  // *state* (not refs) because:
  //   - The three floating menus subscribe to them via React props
  //     and need to re-render once each is created/replaced. With a
  //     ref the menus would render with `null` and never update.
  //   - The react-compiler / react-hooks rules disallow reading
  //     `ref.current` during render, which we'd need to do to thread
  //     the iframe down to the menu components.
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const onBodyChangeRef = useRef(onBodyChange)
  const bodyRef = useRef(body)
  // Latest markdown the editor has actually been synced to. The body
  // round-tripping protocol is:
  //   1. Editor fires onUpdate → we call `onBodyChange(serialised)`.
  //   2. Parent updates its `body` prop → React re-renders us.
  //   3. The body-sync effect sees the new `body` and, if it doesn't
  //      match `lastSyncedMarkdownRef.current`, decides whether to
  //      call `setContent`. Without this ref a fast Enter -> next
  //      keystroke sequence can race: the second transaction has
  //      already advanced the doc by the time the first body update
  //      reaches the effect, the comparator sees a difference and
  //      `setContent` resets the doc — which manifests in the UI as
  //      "Enter doesn't insert a paragraph". The same guard pattern
  //      is used by `TiptapBodyEditor` in Write mode.
  const lastSyncedMarkdownRef = useRef(body)
  // Keep latched refs in sync without mutating them during render. The
  // body ref lets the fetch closure (and the iframe-load handler) read
  // the *current* body without taking a dependency on it — that's how
  // we keep the iframe from reloading on every keystroke.
  useEffect(() => {
    onBodyChangeRef.current = onBodyChange
  }, [onBodyChange])
  useEffect(() => {
    bodyRef.current = body
  }, [body])

  const [preview, setPreview] = useState<PreviewState>({
    status: 'loading',
    html: '',
    error: null,
  })

  // Fetch the rendered template HTML when title / featured-media /
  // entry change. Body is *not* in the dep list — the body editor lives
  // inside the iframe and edits it locally; refreshing the iframe on
  // every keystroke would interrupt typing. We read the current body
  // off `bodyRef` inside the timeout so the request always carries the
  // latest draft.
  const fetchDebounceRef = useRef<number | null>(null)
  const fetchAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (fetchDebounceRef.current !== null) {
      window.clearTimeout(fetchDebounceRef.current)
    }
    fetchDebounceRef.current = window.setTimeout(() => {
      const controller = new AbortController()
      fetchAbortRef.current?.abort()
      fetchAbortRef.current = controller

      const cells = { ...entry.cells, title, body: bodyRef.current }
      previewCmsDataRow(entry.id, { localeId: entry.localeId, cells, signal: controller.signal })
        .then((html) => {
          if (controller.signal.aborted) return
          setPreview({ status: 'ready', html, error: null })
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          const message = getErrorMessage(err, 'Preview failed')
          setPreview({ status: 'error', html: '', error: message })
        })
    }, FETCH_DEBOUNCE_MS)

    return () => {
      if (fetchDebounceRef.current !== null) {
        window.clearTimeout(fetchDebounceRef.current)
      }
    }
  }, [entry.id, entry.localeId, entry.cells, title])

  // Mount the editor into the iframe once it loads. The handler runs
  // every time `preview.html` changes (i.e., every iframe reload). We
  // read the iframe element off the event's `currentTarget` to avoid
  // racing the state setter that the ref callback dispatches.
  const handleIframeLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = event.currentTarget
    if (!iframe || !iframe.contentDocument) return
    if (preview.status !== 'ready') return

    // Tear down any previous editor instance from the prior render.
    setEditor((prev) => {
      prev?.destroy()
      return null
    })

    const target = iframe.contentDocument.querySelector<HTMLElement>('[data-instatic-content-region]')
    if (!target) {
      // The template doesn't include a `base.outlet` module — fall
      // back to read-only preview without an inline editor.
      return
    }

    // Inject our editor-specific style block into the iframe's <head>
    // so the focus outline and trailing-break sentinel disappear. We
    // create the element fresh on every load (the iframe's document
    // is replaced when `srcdoc` changes, so a previous injection is
    // already gone).
    const styleEl = iframe.contentDocument.createElement('style')
    styleEl.setAttribute('data-instatic-live-editor', 'true')
    styleEl.textContent = IFRAME_EDITOR_STYLE
    iframe.contentDocument.head.appendChild(styleEl)

    // The published site's CSS often uses direct-child combinators
    // (e.g. `body > article > article > p { margin: 0 0 1.1rem }`)
    // to scope block-spacing rules tightly. Tiptap mounts its editable
    // div as a child of the content region article, which breaks those
    // chains — `<p>` is no longer a direct child of the inner article,
    // it's a grandchild through the wrapping `<div class="ProseMirror">`.
    // The visible symptom is that headings and paragraphs lose all
    // spacing in Live mode but render normally on the published page.
    //
    // The fix: walk every rule in every same-origin stylesheet and for
    // any selector whose LAST combinator is `>`, append a twin rule
    // that uses descendant combinator for that segment. The original
    // rules keep working for the published-side path; the new rules
    // cover the Tiptap-wrapped case. Specificity is identical so we
    // simply rely on stylesheet ordering — the relaxed rule comes
    // later, so it wins the cascade where both match.
    relaxLastChildCombinators(iframe.contentDocument)

    // Disable navigation inside the iframe. The live preview is an
    // editing surface, not a browsing surface — accidentally clicking
    // a nav link, an in-body anchor, or a button (which could be
    // anywhere relative to the content region) would yank the user
    // out of the entry. We belt-and-braces this in three layers:
    //
    //   1. Strip every `<a href>` and `<form action>` attribute at
    //      load time so the browser's default link/form navigation
    //      can't fire even if our handler is bypassed.
    //   2. Capture-phase click handler on document that swallows
    //      events for any anchor, button, or form-submitting input
    //      anywhere in the page. The handler intentionally does NOT
    //      exempt the content region — Tiptap doesn't need click
    //      events to position the caret (mousedown does that) and
    //      its Link extension already has `openOnClick: false`, so
    //      anchors inside the prose are safe to block at click-time.
    //   3. Capture-phase submit handler for any escaped JS-driven
    //      form submission.
    iframe.contentDocument.querySelectorAll('a[href]').forEach((node) => {
      // Replace the URL with a sentinel so the visual styling stays
      // intact (some templates rely on `:hover` selectors that need
      // a real href to apply) but a default click is a no-op.
      node.setAttribute('data-instatic-href-original', node.getAttribute('href') ?? '')
      node.setAttribute('href', 'javascript:void(0)')
    })
    iframe.contentDocument.querySelectorAll('form').forEach((form) => {
      form.removeAttribute('action')
    })

    const NAVIGABLE_SELECTOR =
      'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]'
    const blockNavigation = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest(NAVIGABLE_SELECTOR)) return
      event.preventDefault()
      event.stopPropagation()
    }
    iframe.contentDocument.addEventListener('click', blockNavigation, true)
    iframe.contentDocument.addEventListener('auxclick', blockNavigation, true)
    iframe.contentDocument.addEventListener(
      'submit',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
      true,
    )

    // Clear whatever the server-rendered HTML put into the body region —
    // Tiptap will render the live document there from the body markdown.
    target.innerHTML = ''

    const nextEditor = new Editor({
      element: target,
      editable: !readOnly,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3, 4] },
          link: { openOnClick: false, autolink: true, linkOnPaste: true },
        }),
        Placeholder.configure({
          placeholder: ({ node }) => {
            if (node.type.name === 'heading') return 'Heading'
            return 'Start writing…'
          },
          showOnlyCurrent: true,
        }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TextAlign.configure({
          types: ['paragraph', 'heading'],
          alignments: ['left', 'center', 'right', 'justify'],
          defaultAlignment: null,
        }),
        MediaNode,
        // Explicit Enter binding — see the extension's doc comment for
        // why the default StarterKit keymap isn't enough inside the
        // iframe. Ordering after StarterKit means our binding takes
        // priority for the Enter key while every other shortcut
        // continues to flow through the default keymap.
        EnterForceSplit,
      ],
      content: markdownToProseMirrorDoc(bodyRef.current),
      editorProps: {
        attributes: {
          'data-testid': 'content-live-body-editor',
          'aria-label': 'Post body (live preview)',
        },
      },
      onUpdate({ editor }) {
        const next = proseMirrorDocToMarkdown(editor.getJSON())
        // Record what we just emitted so the body-sync effect knows to
        // skip the matching parent re-render. Without this, the round
        // trip would call `setContent` on every keystroke and clobber
        // the cursor.
        lastSyncedMarkdownRef.current = next
        onBodyChangeRef.current(next)
      },
    })
    // Initialise the sync guard with whatever the editor was seeded
    // with so the first body-prop update (e.g. parent re-render after
    // mount) doesn't see a phantom mismatch.
    lastSyncedMarkdownRef.current = bodyRef.current

    // ---------------------------------------------------------------
    // Iframe focus + key bridge
    // ---------------------------------------------------------------
    // The browser-test showed that real-world clicks inside a sandboxed
    // same-origin iframe don't reliably transfer focus to the
    // ProseMirror editable region — focus stays on `iframe.contentDocument.body`
    // while only the *selection* moves into the editor. Typing still
    // works because modern browsers route printable-key input into the
    // current selection range, but Enter (and other ProseMirror-only
    // keymap actions) never reaches the view's keydown listener: the
    // event lands on `body`, where there's no handler, so the user
    // sees the cursor flicker but no transaction is dispatched.
    //
    // We defend against this with two listeners:
    //
    //   1. `mousedown` on the iframe document: when the click target
    //      is inside the editor's `view.dom`, force-focus the editor
    //      via Tiptap's command chain. This is idempotent — a no-op
    //      when focus is already correct — and runs in the capture
    //      phase so it beats whatever steals focus on click.
    //   2. `keydown` on the iframe document: if a key is pressed
    //      while the selection is inside the editor but focus isn't,
    //      forward it to the editor by focusing first and re-firing
    //      the matching keymap command. We only do this for Enter
    //      (and Shift-Enter) — the keys we KNOW the default route
    //      drops on the floor. Plain text input continues to flow
    //      through the browser's native contenteditable handling so
    //      we don't interfere with IME / composition.
    const viewDom = nextEditor.view.dom
    const onIframeMouseDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!viewDom.contains(target)) return
      // Browser-tested: synthetic `pm.focus()` reliably sets
      // `activeElement = view.dom` even when the native click delegation
      // misses it.
      if (iframe.contentDocument?.activeElement !== viewDom) {
        viewDom.focus({ preventScroll: true })
      }
    }
    const onIframeKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      // Only step in if the selection sits inside the editor but
      // focus is somewhere else; if PM already has focus, its own
      // keymap will fire and we'd double-trigger.
      const doc = iframe.contentDocument
      if (!doc) return
      if (doc.activeElement === viewDom) return
      const sel = doc.getSelection()
      const anchor = sel?.anchorNode
      if (!anchor || !viewDom.contains(anchor)) return
      // Take over: focus the editor and dispatch the appropriate
      // command. We deliberately preventDefault BEFORE running so
      // the browser's body-level no-op handling doesn't scroll or
      // fire other side effects.
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) {
        nextEditor.chain().focus().setHardBreak().run()
      } else {
        nextEditor.chain().focus().splitBlock().run()
      }
    }
    iframe.contentDocument.addEventListener('mousedown', onIframeMouseDown, true)
    iframe.contentDocument.addEventListener('keydown', onIframeKeyDown, true)

    setEditor(nextEditor)
  }

  // Destroy the editor on unmount.
  useEffect(() => {
    return () => {
      setEditor((prev) => {
        prev?.destroy()
        return null
      })
    }
  }, [])

  // Sync external body changes (e.g. setContent from imperative handle,
  // or a manual edit through the parent's settings panel) into the
  // iframe editor. The dual-guard pattern matches `TiptapBodyEditor`:
  // step 1 short-circuits self-round-trips by recognising the markdown
  // we ourselves emitted; step 2 catches genuine external updates that
  // happen to serialise identically to the editor's current state.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (body === lastSyncedMarkdownRef.current) return
    const currentSerialized = proseMirrorDocToMarkdown(editor.getJSON())
    if (currentSerialized === body) {
      lastSyncedMarkdownRef.current = body
      return
    }
    lastSyncedMarkdownRef.current = body
    editor.commands.setContent(markdownToProseMirrorDoc(body), { emitUpdate: false })
  }, [body, editor])

  // Imperative handle for parity with the Write canvas. Lets the host
  // call focus, insertText, insertMedia, appendBlock from outside.
  useImperativeHandle(
    editorRef,
    (): TiptapBodyEditorHandle => ({
      focusStart: () => editor?.commands.focus('start'),
      insertText: (text) => editor?.chain().focus().insertContent(text).run(),
      insertMedia: (attrs: MediaAttributes) => {
        if (!editor) return
        const isMediaSelected = editor.isActive('media')
        if (isMediaSelected) {
          editor.chain().focus().updateAttributes('media', attrs).run()
        } else {
          editor.chain().focus().insertContent({ type: 'media', attrs }).run()
        }
      },
      appendBlock: (kind) => {
        if (!editor) return
        const node =
          kind === 'heading'
            ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] }
            : { type: 'paragraph' }
        editor.chain().focus('end').insertContent(node).run()
      },
    }),
    [editor],
  )

  // `onInsertDataToken` is part of the Write-canvas contract but the
  // slash menu has been retired in favour of the gutter "+" / bubble
  // menu, so there's no UI in Live mode that calls back into it. Touch
  // the prop to keep its signature parity with the Write canvas.
  void onInsertDataToken

  if (preview.status === 'error') {
    return (
      <div className={styles.shell} data-testid="content-live-canvas">
        <div className={styles.errorState} role="alert">
          <h2>Live preview unavailable</h2>
          <p>{preview.error ?? 'The preview pipeline could not render this entry.'}</p>
          <p className={styles.errorHint}>
            Live mode needs at least one published version of the site so it
            can resolve the entry template. Publish the site once and try again.
          </p>
        </div>
      </div>
    )
  }

  if (preview.status === 'loading' && preview.html === '') {
    return (
      <div className={styles.shell} data-testid="content-live-canvas">
        <div className={styles.loading}>
          <SkeletonBlock minHeight={400} />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.shell} data-testid="content-live-canvas">
      <iframe
        ref={setIframeEl}
        srcDoc={preview.html}
        className={styles.frame}
        title="Live preview"
        // Editing happens inside the iframe via the Tiptap instance we
        // mount after load; allow-scripts is required for plugin runtime
        // assets the publisher injects.
        sandbox="allow-scripts allow-same-origin"
        onLoad={handleIframeLoad}
      />
      {editor && !readOnly && (
        <>
          <BodyBubbleMenu editor={editor} iframeEl={iframeEl} />
          <BodyFloatingMenu
            editor={editor}
            onPickMedia={onPickMedia}
            iframeEl={iframeEl}
          />
          <MediaNodeToolbar
            editor={editor}
            onPickMedia={onPickMedia}
            iframeEl={iframeEl}
          />
        </>
      )}
    </div>
  )
}
