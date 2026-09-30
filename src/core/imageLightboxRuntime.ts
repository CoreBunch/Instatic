/** Self-contained browser runtime, serialized by the server as a same-origin asset. */
export function installImageLightbox(doc: Document): () => void {
  const win = doc.defaultView
  if (!win || !win.HTMLDialogElement?.prototype.showModal) return () => {}
  const host = doc.createElement('div')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = doc.createElement('style')
  style.textContent = `
    :host { all: initial; }
    dialog { position:fixed; inset:0; box-sizing:border-box; width:100%; height:100%;
      max-width:none; max-height:none; margin:0; padding:64px 20px 24px; border:0;
      background:transparent; color:#fff; overflow:hidden; outline:none; }
    dialog[open] { display:grid; place-items:center; }
    dialog::backdrop { background:transparent; }
    .shade { position:absolute; inset:0; background:rgba(0,0,0,.86); opacity:0;
      transition:opacity 220ms ease; }
    img { position:relative; display:block; width:auto; height:auto; max-width:100%;
      max-height:calc(100dvh - 88px); object-fit:contain; opacity:0; transform:scale(.94);
      transition:opacity 220ms ease, transform 260ms cubic-bezier(.2,.7,.2,1);
      box-shadow:0 16px 64px rgba(0,0,0,.3); }
    button { position:absolute; top:max(12px,env(safe-area-inset-top)); right:max(16px,env(safe-area-inset-right));
      display:grid; place-items:center; width:48px; height:48px; padding:0; border:2px solid #fff;
      border-radius:50%; background:#fff; color:#111; font:36px/1 system-ui,sans-serif;
      cursor:pointer; box-shadow:0 2px 16px rgba(0,0,0,.5); }
    button:hover { background:#e5e5e5; }
    button:focus-visible { outline:3px solid #fff; outline-offset:4px; }
    dialog[data-visible] .shade, dialog[data-visible] img { opacity:1; }
    dialog[data-visible] img { transform:scale(1); }
    @media (prefers-reduced-motion:reduce) { .shade, img { transition:none; } }
  `
  const dialog = doc.createElement('dialog')
  dialog.setAttribute('aria-label', 'Image preview')
  const shade = doc.createElement('div')
  shade.className = 'shade'
  const image = doc.createElement('img')
  const closeButton = doc.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', 'Close image preview')
  dialog.append(shade, image, closeButton)
  shadow.append(style, dialog)
  let trigger: HTMLAnchorElement | null = null
  let savedStyle = ''
  let scrollX = 0
  let scrollY = 0
  let closing = false
  let timer = 0
  let frame = 0
  let version = 0

  const finish = () => {
    win.clearTimeout(timer)
    win.cancelAnimationFrame(frame)
    version++
    if (!dialog.open) return
    dialog.close()
    doc.body.style.cssText = savedStyle
    win.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' })
    trigger?.focus({ preventScroll: true })
    trigger = null
    closing = false
    host.remove()
  }
  const close = () => {
    if (!dialog.open || closing) return
    closing = true
    version++
    win.cancelAnimationFrame(frame)
    dialog.removeAttribute('data-visible')
    timer = win.setTimeout(finish, win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260)
  }
  closeButton.addEventListener('click', close)
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target === shade) close()
  })
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (!(target instanceof win.Element)) return
    const link = target.closest<HTMLAnchorElement>('a.instatic-lightbox-trigger')
    const source = link?.querySelector('img')
    if (!link || !source || link.closest('[contenteditable="true"]')) return
    event.preventDefault()
    if (dialog.open) return
    trigger = link
    scrollX = win.scrollX
    scrollY = win.scrollY
    savedStyle = doc.body.style.cssText
    const gutter = win.innerWidth - doc.documentElement.clientWidth
    const padding = parseFloat(win.getComputedStyle(doc.body).paddingRight) || 0
    Object.assign(doc.body.style, {
      position: 'fixed', top: `-${scrollY}px`, left: `-${scrollX}px`,
      width: '100%', boxSizing: 'border-box', paddingRight: `${padding + gutter}px`,
    })
    image.src = source.currentSrc || source.src
    image.alt = source.alt
    dialog.removeAttribute('data-visible')
    doc.body.append(host)
    dialog.showModal()
    closeButton.focus({ preventScroll: true })
    const currentVersion = ++version
    const reveal = () => {
      if (version !== currentVersion || !dialog.open || closing) return
      frame = win.requestAnimationFrame(() => {
        frame = win.requestAnimationFrame(() => dialog.setAttribute('data-visible', ''))
      })
    }
    if (image.decode) void image.decode().then(reveal, reveal)
    else reveal()
  }
  doc.addEventListener('click', onClick)
  return () => {
    doc.removeEventListener('click', onClick)
    finish()
    host.remove()
  }
}
