---
name: run-and-test
description: How an agent boots, drives, and end-to-end tests Instatic, including the parts that are not obvious and cost a session to rediscover. Covers the two dev stacks (bun run dev for manual testing, bun run e2e:serve for automation), the first-run owner account and saved storage state, how to run a single Playwright spec and read its output honestly, how to capture before-and-after screenshots as evidence, and the git worktree setup that Instatic needs before it will run at all (node_modules symlink, isolated .tmp database, never hand-start a server Playwright wants to own). Use this skill before running, previewing, screenshotting, or E2E-testing Instatic, whenever verifying a fix in a worktree, and whenever another skill asks for this project's run-and-test instructions.
---

# Running and testing Instatic

Instatic is a Bun server plus a Vite admin app, backed by SQLite in development. Two stacks exist and they are not interchangeable.

| Stack | Command | Ports | Database | Use for |
|---|---|---|---|---|
| Dev | `bun run dev` | 3000 / 5173 | `.tmp/dev.db`, persistent | Manual testing in a browser |
| E2E | `bun run e2e:serve` | 3002 | `.tmp/e2e-agent.db`, **wiped each start** | Automated testing |

The E2E stack builds the admin (`bun run build`) and serves it from the Bun server on one origin, so the suite exercises the bundle users get and has no Vite dev server in it. Every run starts with that build (about 10 to 30 s). It deliberately runs without `--watch`: publishing writes baked HTML and churns SQLite, which under watch reloads the server mid-test and tears the run down.

## Do not hand-start the E2E server

`playwright.config.ts` declares a `webServer` running `bun run e2e:serve`. Playwright starts and stops it itself. Starting it manually first produces:

```
Error: http://127.0.0.1:3002 is already used, make sure that nothing is
running on the port/url or set reuseExistingServer:true
```

Just run `playwright test`. To reuse a server you already have up, set `E2E_REUSE_SERVER=1`.

The same error also appears when another session's run holds the port. Do not kill it; see "The port may be someone else's".

## First run needs an account, and it is already handled

Instatic has no seeded login. A clean database lands on a first-run setup form. You do not have to drive it: the `setup` Playwright project (`tests/e2e/auth.setup.ts`) completes setup once per run and saves the owner's `storageState` to `.tmp/e2e-owner-state.json`. Every ordinary spec opts into that state and starts logged in.

Identities live in `tests/e2e/helpers/constants.ts`:

```
owner.e2e@example.com / qwerty123456     site: "Automated E2E Site"
admin and public  http://127.0.0.1:3002  (one origin)
```

Two cases must opt out of the saved state and log in fresh: specs that **publish** (publishing triggers a step-up challenge) and specs that **sign out**. Use `ANONYMOUS_STATE` for those.

## Running specs

```bash
bunx playwright test --project=e2e <spec-name-fragment>
bunx playwright test --project=e2e -g "CONTENT-009"
```

`workers: 1` and `fullyParallel: false`: the whole suite shares one database and one server, so specs run serially and order matters.

**Read the pass count honestly.** The `e2e` project declares `dependencies: ['setup', 'personas']`, and `personas` depends on `dashboard-preflight`. Running one spec therefore drags in five fixture tests:

```
setup (auth)                  1
dashboard-preflight           3
personas                      1
your spec                     1
                        = "6 passed"
```

Never report "6 passed" as if six tests validated your change. Name the test that matters.

## Evidence

Playwright writes a screenshot automatically for a failing test to `.tmp/playwright-results/<spec>/test-failed-1.png`. When proving a bug exists before a fix, that failure screenshot **is** the "before" image.

For the "after", take one explicitly:

```ts
await page.screenshot({ path: '.tmp/evidence/after-<thing>.png' })
```

Hand both to whoever asked for the change. A path nobody opens is not evidence.

Console and network are available for assertions that a screenshot cannot make:

```ts
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const res = await page.waitForResponse((r) => new URL(r.url()).pathname === '/admin/api/...')
```

## Forcing a race deterministically

Timing bugs will not reproduce by clicking. Hold a response until the state you need has happened:

```ts
let release: () => void = () => {}
const held = new Promise<void>((r) => { release = r })
let heldOnce = false
await page.route(/\/admin\/api\/cms\/data\/tables\/[^/]+\/rows(\?.*)?$/, async (route) => {
  if (!heldOnce && route.request().method() === 'GET') { heldOnce = true; await held }
  await route.continue()
})
// ...trigger the action that must win...
release()
```

This is how the sidebar-title race (CONTENT-009) was pinned down. Always confirm such a test **fails without the fix**, or it proves nothing.

## Worktrees

Verification happens in a throwaway worktree off current `origin/main`, at `.worktrees/<slug>`, which is already gitignored here. Instatic needs two things before it will run there:

```bash
git worktree add -f -b verify/pr-<N> .worktrees/pr-<N> origin/main
ln -s "$PWD/node_modules" .worktrees/pr-<N>/node_modules   # run from the main checkout
```

- **Symlink `node_modules`.** A fresh `bun install` per worktree is minutes wasted; the symlink works.
- **`.tmp/` is per-worktree**, so the E2E database is naturally isolated. Nothing to clean up between worktrees.
- Each worktree's run wants port 3002 by default. See "The port may be someone else's" below before you start one.

## The port may be someone else's

Several sessions work in this repo at once, each in its own worktree, and every E2E run defaults to port 3002. A server on that port is as likely to be another session's suite mid-run as a leftover of yours. **Never free the port blindly:** `lsof -ti :3002 | xargs kill` ends whoever holds it, and the other session sees all its remaining tests fail with "connection refused".

Before a run, see who holds the port and where that process was started:

```bash
for pid in $(lsof -ti tcp:3002 -sTCP:LISTEN); do echo "pid $pid"; lsof -a -p "$pid" -d cwd -Fn | grep '^n'; done
```

- **Nothing printed:** the port is free. Run normally.
- **The directory is your own worktree:** it is a leftover from a run of yours that died. Stop that one process by its pid (`kill <pid>`), nothing wider.
- **Any other directory:** it belongs to another session. Leave it running and put your run on another port:

```bash
E2E_CMS_PORT=3012 E2E_ADMIN_BASE_URL=http://127.0.0.1:3012 bunx playwright test --project=e2e tests/e2e/<spec>.e2e.ts
```

`E2E_CMS_PORT` moves the server and `E2E_ADMIN_BASE_URL` points the suite at it; the public base URL follows the admin one. Check the alternate port the same way first, and pick another if it is taken too.

## The verify gate

```bash
bun run build > /tmp/b.log 2>&1; echo "BUILD_EXIT=$?"   # tsc -b && vite build
bun run lint  > /tmp/l.log 2>&1; echo "LINT_EXIT=$?"
bun test      > /tmp/t.log 2>&1; echo "TEST_EXIT=$?"
```

Capture exit codes directly. `bun run build | tail` reports the exit status of `tail`, which is how a PR with two TypeScript errors once looked green.

`bun run doctor` (react-doctor) is the configured gate and passes at exit 0; the raw CLI with `--fail-on warning` reports ~729 repo-wide warnings and is a stricter bar than the repo holds itself to. The `.git/hooks/pre-commit` hook runs react-doctor but **exits 0 regardless**, so it warns and never blocks. Run the real gate yourself.

## Registering new E2E coverage

A new spec is not finished until it is registered in the feature matrix and the validation TSV. The `maintain` skill owns that obligation and the exact columns; follow it rather than a copy kept here.

## Flake discipline

`bun test` walks files in filesystem order, which differs between APFS locally and ext4 in CI, so store and global state leaking between files produces failures that appear on one machine only. `src/__tests__/setup.ts` resets the app stores before each file to contain this.

Before blaming a PR for a failure: run the suite three times on the branch and three times on base. One failure in one run is not evidence, and three passes do not prove a fix for an intermittent bug.
