/**
 * Shared fixtures for the siteImport test suite.
 *
 * Provides a synthetic "sample site" with:
 *   - 3 HTML pages (index.html, about.html, contact.html)
 *   - 2 CSS files (styles/main.css, styles/theme.css)
 *   - 2 images as minimal 1×1 PNG bytes (images/hero.png, images/logo.png)
 *   - 2 linked JS files (classic vendor + module app) imported as runtime
 *   - 1 unlinked JS file that remains non-runtime
 *   - 1 hidden file (.DS_Store) — dropped during ingest
 *
 * All file bytes are synthetic ASCII / PNG stubs — not real media.
 */

import type { FileMap } from '@core/siteImport'

// ---------------------------------------------------------------------------
// Minimal 1×1 transparent PNG (89 bytes)
// Generated via: python3 -c "import zlib, struct; ..." — see below
// ---------------------------------------------------------------------------

// A valid 1×1 transparent PNG as a base-64-like Uint8Array literal.
// This is the smallest legal PNG that browsers and image decoders accept.
export const MINIMAL_PNG: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth=8, color=RGB, CRC
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed scanline
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // CRC
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
  0x44, 0xae, 0x42, 0x60, 0x82,                   // IEND CRC
])

// ---------------------------------------------------------------------------
// Text encoder
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function txt(s: string): Uint8Array { return enc.encode(s) }

// ---------------------------------------------------------------------------
// Sample HTML pages
// ---------------------------------------------------------------------------

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Home Page</title>
  <link rel="stylesheet" href="styles/main.css">
  <link rel="stylesheet" href="styles/theme.css">
</head>
<body>
  <h1 class="hero-title">Welcome</h1>
  <img src="images/hero.png" alt="Hero">
  <a href="about.html">About us</a>
  <p>Hello world</p>
  <script src="scripts/vendor.js"></script>
  <script type="module" src="scripts/app.js"></script>
</body>
</html>`

const ABOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>About Us</title>
  <link rel="stylesheet" href="styles/main.css">
</head>
<body>
  <h1 class="page-title">About</h1>
  <img src="images/logo.png" alt="Logo">
  <p>We are a company.</p>
</body>
</html>`

const CONTACT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Contact</title>
  <link rel="stylesheet" href="styles/main.css">
</head>
<body>
  <h1>Contact Us</h1>
  <a href="mailto:hello@example.com">Email us</a>
  <p>Get in touch.</p>
</body>
</html>`

// ---------------------------------------------------------------------------
// Sample CSS files
// ---------------------------------------------------------------------------

const MAIN_CSS = `.hero-title {
  color: red;
  font-size: 2rem;
}

.page-title {
  color: blue;
}

h1 {
  margin: 0;
}

body {
  background-color: white;
  background-image: url('images/hero.png');
}
`

const THEME_CSS = `.btn-primary {
  background: green;
  color: white;
}

@media (max-width: 768px) {
  .hero-title {
    font-size: 1.5rem;
  }
}
`

// ---------------------------------------------------------------------------
// Sample FileMap
// ---------------------------------------------------------------------------

/**
 * A complete FileMap for the synthetic sample site.
 * Use this as the input to `buildImportPlan` in tests.
 */
export function makeSampleFileMap(): FileMap {
  return {
    files: {
      'index.html':        { bytes: txt(INDEX_HTML),   mimeType: 'text/html' },
      'about.html':        { bytes: txt(ABOUT_HTML),   mimeType: 'text/html' },
      'contact.html':      { bytes: txt(CONTACT_HTML), mimeType: 'text/html' },
      'styles/main.css':   { bytes: txt(MAIN_CSS),     mimeType: 'text/css' },
      'styles/theme.css':  { bytes: txt(THEME_CSS),    mimeType: 'text/css' },
      'images/hero.png':   { bytes: MINIMAL_PNG,       mimeType: 'image/png' },
      'images/logo.png':   { bytes: MINIMAL_PNG,       mimeType: 'image/png' },
      'scripts/vendor.js': { bytes: txt('window.vendorReady = true'), mimeType: 'application/javascript' },
      'scripts/app.js':    { bytes: txt('import "./vendor.js"; console.log("hello")'), mimeType: 'application/javascript' },
      'scripts/unused.js': { bytes: txt('console.log("unused")'), mimeType: 'application/javascript' },
      // Hidden file — should be filtered out during ingest (not normally in a FileMap,
      // but included here to test any code that receives raw FileMaps)
    },
  }
}

/**
 * A minimal single-page FileMap for quick unit tests.
 */
export function makeSinglePageFileMap(html?: string, css?: string): FileMap {
  const files: FileMap['files'] = {
    'index.html': { bytes: txt(html ?? INDEX_HTML), mimeType: 'text/html' },
  }
  if (css !== undefined) {
    files['style.css'] = { bytes: txt(css), mimeType: 'text/css' }
  }
  return { files }
}
