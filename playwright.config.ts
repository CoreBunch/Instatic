import { defineConfig } from '@playwright/test'
import { OWNER_STATE_FILE } from './tests/e2e/helpers/constants'

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL ?? 'http://127.0.0.1:5174'
process.env.E2E_PUBLIC_BASE_URL ??= 'http://127.0.0.1:3002'
const LOCAL_TRACE = process.env.E2E_TRACE === '1'
const LOCAL_VIDEO = process.env.E2E_VIDEO === '1'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: '.tmp/playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.tmp/playwright-report' }],
  ],
  use: {
    baseURL: ADMIN_BASE_URL,
    screenshot: 'only-on-failure',
    // The full single-worker suite keeps every open SSE request in a trace.
    // Recording every local test can therefore consume gigabytes before the
    // worker finishes and discards passing artifacts. Keep local capture opt-in;
    // CI records only the first retry, where an artifact is actionable.
    trace: process.env.CI ? 'on-first-retry' : LOCAL_TRACE ? 'retain-on-failure' : 'off',
    video: process.env.CI ? 'on-first-retry' : LOCAL_VIDEO ? 'retain-on-failure' : 'off',
  },
  // The disposable DB is set up once per run, so first-run setup runs in its own
  // `setup` project. Dashboard preflight then verifies clean-install facts before
  // persona/capability specs mutate site-wide users and plugins. `personas` creates
  // accounts used by destructive self-management specs; those specs must never
  // revoke the shared owner session that ordinary specs reuse.
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: 'dashboard-preflight',
      testMatch: /dashboard\.e2e\.ts$/,
      dependencies: ['setup'],
      use: { storageState: OWNER_STATE_FILE },
    },
    {
      name: 'personas',
      testMatch: /account-persona\.setup\.ts$/,
      dependencies: ['dashboard-preflight'],
    },
    {
      name: 'e2e',
      testMatch: '**/*.e2e.ts',
      testIgnore: /dashboard\.e2e\.ts$/,
      dependencies: ['setup', 'personas'],
      use: { storageState: OWNER_STATE_FILE },
    },
  ],
  webServer: {
    command: 'bun run e2e:dev',
    url: ADMIN_BASE_URL,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 500 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
