# mobile-qa

Real-phone screenshots of public web pages, run on GitHub Actions:

- **iOS**: Safari on the iOS Simulator (macOS runner), driven by `safaridriver`; screenshots of the whole device screen.
- **Android**: Chrome on the Android emulator (Linux runner, KVM), driven by Playwright's Android API; device screenshots.

Each page gets up to N scroll positions, a layout probe (horizontal overflow and the elements causing it, small tap
targets, viewport meta, HTTP status) and, on Android, JS errors, console errors and failed requests.

```bash
node bin/mobile-qa.mjs https://example.com https://example.com/pricing [--platforms ios,android] [--out DIR]
```

## Private pages (kit-qa qa-agent sites)

```bash
kit-qa exec easycustom -- node bin/mobile-qa.mjs --private /#sales /#inventory [--platforms ios,android]
```

Shows the signed-in pages on the real phones. A private call takes 5-20 minutes (iOS can take longer): start it in the
background (`kit-heavy`), never as a foreground command, and watch its log. One private call at a time (a lock file on
this machine, and the single repo secret). Results go to `D:/Kit/tmp_research/mobile-qa-private/<run id>`; they show
real admin data: delete that folder after looking.

How it works. Only paths on the site's own origin are accepted (another host, credentials, a trailing-dot host or a
token site are refused). The 2 h QA Agent session cookies of that host (the host itself or a parent domain with a dot;
never `QA_AGENT_KEY`) are sealed with a fresh AES-256-GCM key kept in the repo secret `PRIVATE_QA_KEY` (set through
stdin) and only ciphertext is sent as the workflow input `private_job`. The runner seals every result before upload.
The client unseals locally, scans the run log and the raw artifact, deletes the run and replaces the secret with random
bytes first thing when cleaning up (also on failure or Ctrl-C; leftovers are swept on the next call). The QA session is
not logged out (that would kill it for other kit-qa users): it expires by itself within 2 h.

What is and is not blocked. Android: service workers are blocked; one context-level route (awaited before any page
loads, fail closed: if it cannot be installed nothing is loaded) aborts same-origin non-GET/HEAD/OPTIONS requests from
every tab, and same-origin WebSockets are closed (when the context supports it; the run notes say if not);
confirm/prompt/alert dialogs are dismissed, only beforeunload is accepted. Writes to other origins are not blocked.
**iOS: writes are not blocked** (Safari offers no request interception); the run only loads and scrolls, but the page's
own code can still send requests with the QA session. Do not call this "read-only" beyond the list above.

What stays public while a run exists: the run name (`pq-<minute>-<hex>`), the workflow inputs (ciphertext of
the job, its length, platforms), the step names and timings, and the artifact sizes. Nothing else is meant to appear:
the log prints page numbers and fixed messages only (an allow-list; anything else is dropped), and a hostname in the log
or a readable marker in the raw artifact makes the call exit 2. Cookie values and the key cannot be checked in the log
(GitHub masks them); they rest on the encryption and the allow-list.

Limits to know. Third-party scripts inside the admin page run with the QA session. The runner process drops the key
and the job from its environment as soon as it has read them, so child processes never see them; the Android emulator
action itself still receives the step env (pinned by SHA), which holds them. Private runs do not restore or save the
shared AVD cache (the emulator image is created fresh, a few minutes slower). `MOBILE_QA_REF=<branch>` runs that
branch's workflow (to test before merging).

Self-check: `npm test`; fixtures at https://kasher07.github.io/mobile-qa/; fault paths with `MOBILE_QA_TEST_STARVE_IOS=1`,
`MOBILE_QA_TEST_FAULT=android-setup` and `--ios-mode openurl`.

The client dispatches `.github/workflows/mobile-qa.yml`, waits, downloads the artifacts and deletes the run, so URLs
and screenshots do not stay public. Only public URLs are accepted (no localhost, private IPs, credentials or
secret-looking query parameters).

## App QA (bin/app-qa.mjs): where the iOS half runs

`app-qa` runs an Expo app's Maestro flows on real release builds. Android always runs on the GitHub emulator (one job
per flow; free on this public repo). iOS has three runners, and the tool picks one before every iOS run so no minutes are
wasted and nothing queues:

- **Codemagic account #1, #2, ...**: Mac mini M2, all iOS flows in one simulator session. Free personal plan: 500 build
  minutes a month and one build at a time per account. Accounts are the file pairs `codemagic.json` + `codemagic.token`
  (account 1) and `codemagic-<n>.json` + `codemagic-<n>.token` (n >= 2) in the kit folder (`%LOCALAPPDATA%/kit-app-qa`);
  the json holds `{ "appId", "workflowId" }` (`app-qa-ios` in `codemagic.yaml`), the token file the account's API token.
  Everything a job needs is a build variable, so a new account needs only the app added from this repo and its two files.
  `CODEMAGIC_TOKEN` in the environment is a single-account override (that token with account 1's app id).
- **GitHub macOS shards** (`--ios-on github`): free on this public repo but ~9 min of Mac setup per flow, so slower.

The picking rule (`bin/app-qa-pool.mjs`, run right before the build starts):

1. Ask each account for its builds: `GET /builds?appId=<id>&limit=50&skip=<n>` (newest first; each build has `status`,
   `createdAt`, `startedAt`, `finishedAt`; paged until the month starts). The REST docs page only describes `POST
   /builds`; the fields above were read from a real response.
2. Busy = a build whose status is not final (`finished`, `failed`, `canceled`, `timeout`, `skipped`, `warning`) and was
   created less than 4 h ago, or the account was claimed by another app-qa call on this machine less than 3 min ago
   (`pool-claims.json`; the list can lag behind a just-started build).
3. Minutes used = whole minutes (rounded up per build) from `startedAt` to `finishedAt` (to now while running) of the
   builds started this calendar month, UTC. It is an estimate of the plan's billing month; quota 500
   (`APP_QA_CM_MONTHLY_MINUTES` to change it).
4. Take the **idle account with the most minutes left**, if it has at least **45** left (a build may run 40 min); ties
   go to the lower number. That spreads the month's minutes evenly over the accounts.
5. Every account busy, nearly out of minutes or unreachable (or none configured): **GitHub macOS shards**, never a
   queue. The log says why: `ios lane: GitHub macOS - GitHub macOS shards instead of queueing: #1 busy, #2 only 30 min left`.

`--ios-on github` forces GitHub; `--ios-on codemagic` forces Codemagic (the best account, queueing if all are busy);
`--ios-on codemagic:2` forces account 2. A background iOS run records its account in its state file, so the detached
process polls with the right token. Not done: splitting one `--ios wait` run across two accounts (a second build means a
second native build, doubling its minutes for a modest time gain, and it cannot be tested without spending minutes).

Self-check: `npm test` (the picker and config loader are pure/fake-API tests in `test/app-qa-pool.test.mjs`).

### Is device QA worth running at all? (`--changed`)

`--changed` compares the app files with the last passing run of each platform and looks the difference up in the app's
`.maestro/flows-map.json` (`ignore`, `all`, `rules`, `dark`). It then decides, and prints one line saying what and why:
`app-qa: Android 2 flows (01-read, 04-resume); iOS waits for the land/release step (no iOS-specific change)`
(`--lang vi` for Vietnamese, plus a parseable `decision-code:` line; `--plan-only` prints it and stops, nothing packed or started).

1. Only ignored files (tests, docs, maps) or nothing changed: **no run at all**.
2. `--unit-covered a,b` (files a unit test that was green in the same verify run imports directly; the caller proves it):
   a plain `.ts` module (no JSX, not in `all`) that no flow lists is skipped; one that a flow lists runs those flows on
   **Android only** (free; the tests cover the logic, the flow the wiring). Screens, components, `all` files and anything
   uncovered keep their flows on both platforms.
3. `--ios-when risk` (with `--ios background`): iOS starts now only when something iOS-specific changed since iOS last
   passed: a file matching `ios.paths` in the map, a file whose text matches `ios.content` (safe-area, NativeTabs, Glass,
   fonts ...), a changed flow, or no earlier iOS pass. Otherwise iOS is deferred without moving its snapshot, so the next call
   with `--ios-when always` (the default; a land step or a release) runs every iOS flow for everything changed since the
   last iOS pass: several UI commits share one iOS run. `--ios wait` (store builds) is never deferred.
