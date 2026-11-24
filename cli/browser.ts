export function parseViewport(input?: string) {
  const viewport = /^(\d{2,4})x(\d{2,4})$/.exec(input ?? '1280x800')
  if (!viewport || viewport.slice(1).some(value => Number(value) < 10 || Number(value) > 4096)) {
    throw new Error('Viewport must be WIDTHxHEIGHT, from 10 to 4096 pixels per dimension')
  }
  return { width: Number(viewport[1]), height: Number(viewport[2]) }
}

export async function openChromium() {
  const { chromium } = await import('playwright-core')
  return chromium.launch({ executablePath: process.env.INSTATIC_CHROMIUM || undefined }).catch((err: unknown) => {
    throw new Error('Could not launch Chromium. Set INSTATIC_CHROMIUM to your installed browser executable or install the matching Playwright Chromium with user approval. ' +
      (err instanceof Error ? err.message : String(err)), { cause: err })
  })
}
