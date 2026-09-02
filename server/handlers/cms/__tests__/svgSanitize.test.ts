import { describe, expect, it } from 'bun:test'
import { sanitizeSvgBytes } from '../svgSanitize'

const enc = new TextEncoder()

describe('sanitizeSvgBytes', () => {
  // The DOMPurify SVG profile is only reliable on the jsdom runtime the server
  // installs. happy-dom, the bun-test default DOM, mishandles the SVG node walk
  // (it drops geometry after a removal and can even leave a javascript: URL in
  // an <animate>), so a test on the ambient DOM would not reflect production.
  // Run the sanitiser in a clean process with the real server runtime.
  it('removes scripting vectors while keeping geometry (jsdom runtime, GHSA-5h25)', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `
          await import('./server/richtextSanitizer.ts')
          const { sanitizeSvgBytes } = await import('./server/handlers/cms/svgSanitize.ts')
          const enc = new TextEncoder(), dec = new TextDecoder()
          const clean = (s) => dec.decode(sanitizeSvgBytes(enc.encode(s))).toLowerCase()
          const must = (cond, msg) => { if (!cond) throw new Error(msg) }

          const geo = clean('<svg viewBox="0 0 10 10"><rect width="10" height="10"/><circle r="4"/></svg>')
          must(geo.includes('<rect') && geo.includes('<circle'), 'geometry stripped: ' + geo)

          // Plain AND namespace-prefixed script elements removed. The prefixed
          // form is a real SVG script element that a byte-level regex could not
          // match; geometry after it must survive.
          for (const s of [
            '<svg><script>alert(1)</script><rect/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><rect/></svg>',
          ]) {
            const o = clean(s)
            must(!o.includes('<script') && !o.includes('<s:script'), 'script survived: ' + o)
            must(o.includes('<rect'), 'rect lost: ' + o)
          }

          const banned = [
            ['<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject><rect/></svg>', ['foreignobject', 'onerror']],
            ['<svg><style>@import url(javascript:alert(1))</style><rect/></svg>', ['<style', 'javascript:']],
            ['<svg onload="alert(1)"><rect onclick="alert(2)"/></svg>', ['onload', 'onclick']],
            ['<svg><a xlink:href="&#106;avascript:alert(1)"><text>x</text></a></svg>', ['javascript:']],
            ['<svg><a><animate attributeName="xlink:href" values="javascript:alert(1)"/></a></svg>', ['javascript:']],
            ['<svg><scr<script>ipt>alert(1)</scr</script>ipt><rect/></svg>', ['<script']],
          ]
          for (const [input, tokens] of banned) {
            const o = clean(input)
            for (const t of tokens) must(!o.includes(t), 'expected "' + t + '" gone from ' + JSON.stringify(input) + ', got: ' + o)
          }
        `,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr))
    }
  })

  it('returns empty bytes for empty / whitespace input', () => {
    expect(sanitizeSvgBytes(enc.encode('   ')).length).toBe(0)
    expect(sanitizeSvgBytes(new Uint8Array(0)).length).toBe(0)
  })
})
