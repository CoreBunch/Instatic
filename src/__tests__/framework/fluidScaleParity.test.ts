/**
 * computeFluidScale must mirror Core Framework's `getTypeScale` exactly.
 *
 * The key invariant: Core Framework does NOT swap min/max when the min-screen
 * size exceeds the max-screen size (its swap is commented out). `min` is the
 * size at the min screen width, `max` at the max screen width — an ordering by
 * breakpoint, not by value. At steps below the base, the larger max-screen
 * ratio compresses the size below the min-screen one, so min > max, and the
 * emitted `clamp(min, …, max)` correctly pins to the min-screen size.
 *
 * Source of truth (verbatim formula):
 *   core-framework/packages/core/src/components/modules/typography/functions/getTypeScale.ts
 */
import { test, expect } from 'bun:test'
import { computeFluidScale } from '@core/framework'

test('computeFluidScale matches Core Framework getTypeScale — no min/max swap', () => {
  // Default typography scale (16→18px, Major Second→Perfect Fourth, 320–1400px).
  const scale = computeFluidScale({
    minBaseSize: 16,
    maxBaseSize: 18,
    minScaleRatio: 1.125,
    maxScaleRatio: 1.333,
    steps: 8, // xs,s,m,l,xl,2xl,3xl,4xl
    baseScaleIndex: 2, // base = "m"
    minScreenWidth: 320,
    maxScreenWidth: 1400,
  })

  // Step 0 ("xs"), i = -2: the max-screen size (10.13) drops BELOW the
  // min-screen size (12.64). Core Framework keeps them unswapped.
  expect(scale[0].min).toBe('12.64') // 16 * 1.125^-2
  expect(scale[0].max).toBe('10.13') // 18 * 1.333^-2

  // Base step ("m", i = 0) is exactly the base sizes at each breakpoint.
  expect(scale[2].min).toBe('16')
  expect(scale[2].max).toBe('18')

  // Above the base the ordering is the intuitive one (min-screen < max-screen).
  expect(Number(scale[7].min)).toBeLessThan(Number(scale[7].max)) // "4xl"
})
