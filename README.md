# mobile-qa

Real-phone screenshots of public web pages, run on GitHub Actions:

- **iOS**: Safari on the iOS Simulator (macOS runner), driven by `safaridriver`; screenshots of the whole device screen.
- **Android**: Chrome on the Android emulator (Linux runner, KVM), driven by Playwright's Android API; device screenshots.

Each page gets up to N scroll positions, a layout probe (horizontal overflow and the elements causing it, small tap
targets, viewport meta, HTTP status) and, on Android, JS errors, console errors and failed requests.

```bash
node bin/mobile-qa.mjs https://example.com https://example.com/pricing [--platforms ios,android] [--out DIR]
```

## Flows: scripted steps (tap, type, Back, swipe, expect, screenshots)

```bash
node bin/mobile-qa.mjs --steps examples/flows.json [--steps more.json] [--allow-post /api/rpc] [--allow-writes "<reason>"] [--platforms ios,android]
kit-qa exec <site> -- node bin/mobile-qa.mjs --private --steps flows.json     # signed-in pages: start is a path, steps travel sealed
```

**Flows run on Android only unless you ask for iOS**: with `--steps` the default platform is Android; `--platforms ios,android` (or `ios`) must be
stated explicitly, and the summary says "iOS was not asked" otherwise (plain URL mode keeps its ios,android default). iOS is slow on the hosted
Macs, its guard is only a page script and it failed 3 of 3 flows in the first real pilot. Several `--steps` files can be given in one call (their
flows are merged; the caps below apply to the total). **The `allowWrites` / `allowPost` of a file apply to that file's flows only**; the `--allow-writes` /
`--allow-post` flags are call-wide (printed as such) and apply to every flow; the 5-path cap counts the union.

A flow file holds up to 6 flows (name, `start` URL or, with `--private`, a path on the site, up to 60 steps, `examples/flows.json` is a
working one). A step is an object with one action key; a screenshot of the whole device screen (browser bars and the on-screen keyboard
when it is up) is taken after every step and on a failure.

| step | meaning |
|------|---------|
| `{"tap": "#go"}` / `{"tap": {"text": "Save"}}` | CSS selector, or the deepest element whose visible text contains the text |
| `{"type": {"selector": "#q", "text": "hello", "clear": true}}` | focus the field, type |
| `{"longpress": {"on": ".card", "ms": 600}}` | hold: `on` is a selector, `{"text": ...}` or a point `[x, y]`; 300..3000 ms (default 600). A swipe with from == to is refused: use this |
| `{"key": "Enter"}` | Enter, Tab, Backspace, Escape |
| `{"back": true}` / `{"forward": true}` | browser history |
| `{"scroll": {"to": "#x"}}` / `{"scroll": {"by": 600}}` | into view / pixels |
| `{"swipe": {"on": ".carousel", "direction": "left"}}` / `{"swipe": {"from": [0.8, 0.5], "to": [0.2, 0.5]}}` | direction = the way the content moves; from/to are fractions of the screen |
| `{"wait": {"selector": "#x", "state": "visible"}}` (or `"gone"`, `"text"`, `"timeout"` ms) / `{"wait": {"ms": 500}}` | wait (max 20 s / 10 s) |
| `{"expect": {"selector": "#x", "visible": true}}` | also `"count": 3` and `"inViewport": true` (not hidden under the keyboard; the answer depends on how Chrome resizes the page for the keyboard, so a flow that must be stable should look at the `shot` too); polls up to 2 s; a miss fails the flow |
| `{"shot": "name"}` | an extra named screenshot |

Selectors are plain CSS only (no `text=`, `xpath=`, `>>`, `:has-text`: they would not mean the same on Safari); selectors and texts are data
handed to Playwright's locator or WebDriver's find-element, never evaluated as code. Limits: 30 s per step (the step itself; its screenshot has its own cap), 4 min per flow, 60 steps,
6 flows, the file at most 20 kB (bytes). If Chrome closes its tab or refuses a new target while a flow starts ("Target.createTarget: Not supported", seen in the first pilot; cause not proven, a launch right after the previous Chrome context closed is the suspect), the flow is retried ONCE on a fresh browser and the summary carries a "RETRIED ONCE" note with the first attempt's blocked/allowed counts next to the second's: never silent.
**A flow that allows any POST (`allowWrites` or `allowPost`) is never retried**: loading its page again could send a POST twice; it fails with the launch error and says so.
A failed flow still lists the allowed POSTs it made and the requests it blocked up to the failure A step that times out closes its page and is waited for, so it cannot act on the next flow;
a run that returns fewer flow results than asked is an issue (exit 1). A failed step or `expect` stops its flow, is an issue (exit 1) and keeps its screenshot; the layout probe
(overflow, tap targets) also runs on each flow's end state. Output: `<out>/<run>/<platform>/flows/<name>/summary.md` (each step's result,
time, how it was done, screenshot) plus the screenshots next to it.

**What each platform really does.**
- **Android** (Chrome on the emulator): tap and swipe are real touches injected below the browser with `adb shell input` (the soft
  keyboard shows, the toolbar reacts); because adb works in screen pixels, a transparent overlay measures the page-to-screen offset before
  a touch and eats that one tap. Typing sends DevTools key events after a real tap has focused the field (the keyboard app itself is not
  typed into). A tap on a non-field target while the keyboard is up closes the keyboard first (Back), because Chrome then shrinks and pans the visual viewport and page coordinates stop matching the screen; the step says so, and `expect ... inViewport` is how a flow checks what the keyboard hides. Back is the hardware Back key (with the keyboard up the first Back only closes the keyboard, as on a phone). Forward has
  no key on Android: DevTools history. Scroll is a script scroll. If `adb input` fails the step falls back to a DevTools touch, then to a
  click, and the summary says which one was used.
- **Long press:** Android holds a real touch for `ms` (`adb input swipe` from a point to the same point). On iOS it sends W3C touch pointer
  actions with a pause and checks that the page saw a pointerdown and a pointerup that far apart (still WebDriver, **not a finger**); if the page saw no
  hold it dispatches pointer/mouse down and up from script, holds, releases (no click) and says "NOT a finger" in the summary.
- **iOS** (Safari on the Simulator, WebDriver): tap is a **WebDriver element click** (a synthesized click, not a finger); the page must
  see a click on the element, else the step falls back to a script click (or fails if the click landed elsewhere) and says so. Typing
  is click + sendKeys, verified against the field's value; when Safari ignores the text (measured on iOS 26.2: it does) the step retries
  with key actions and finally sets the value by script with input/change events, flagged "NOT typed" in the summary. Keys are WebDriver
  key actions, Back/Forward are WebDriver history. Swipe uses W3C pointer actions of type `touch`, but the step checks that something
  scrolled; measured on iOS 26.2 the actions are accepted and do nothing, so the swipe is done as a script scroll and the summary says
  "NOT a finger swipe". The on-screen keyboard did not appear for synthesized focus. So on iOS the flow proves the page's logic, not
  finger or keyboard behaviour. Pinch and multi-finger gestures are not available on either platform.
  A Back that WebDriver does not answer within 12 s is repeated as a script `history.back()` and flagged; the first simulator screenshot gets 90 s (later ones 45 s, one retry
that is noted) because a 30 s limit ended in ETIMEDOUT; the first-run Safari tip bubble is closed by the warm-up (3 passes, one retry of the warm-up), and when the
warm-up itself fails the bubble can still cover the bottom bar of the screenshots.
  **Known limit:** on a heavy live page (measured on a charting dashboard) the iOS swipe can hang safaridriver; the step then fails at its
  cap, the flow stops and no further WebDriver call is made.

**Read-style POSTs (`allowPost`).** Some pages READ with a POST (an RPC endpoint: the page's data call is a POST), and under no-writes they show their
error state and nothing behind them can be reached. `"allowPost": ["/api/rpc"]` in the steps file, or `--allow-post <path>` (repeatable), lets POST
requests through to those paths only: **same origin as the flow's start page, exact path (no wildcards; a query does not matter), POST only (PUT, PATCH and
DELETE stay blocked), at most 5 paths**. Every allowed request is counted and listed by path in the flow summary, the list is printed at the start of the
run, and it is refused when the session is write-protected (a minted session, `KITQA_NO_WRITES`), exactly like `allowWrites`. In public mode the paths
travel in the public input and go through the secret-looking check. On iOS the page-script guard applies the same list, resolving URLs against `document.baseURI` as the browser does (requests the page makes while it
loads are not seen there, so they are neither blocked nor counted; **iOS counts are a lower bound**: counts are read while a step settles, a document that is replaced
between two reads takes its last requests with it). Only fetch/XHR-type requests on a listed path pass, on both platforms: a form POST, a beacon or a navigation to
a listed path stays blocked. `/`, dot segments and percent-encoded dots or slashes are refused as paths. **This is for RPC-style reads only: a path whose POST can change data must never be
listed**, and a path that carries both reads and writes (one endpoint, the action in the body) cannot be listed at all, because the match is by path. The
caller reads the repo's handler first and says in the report which handler each path is. Fixture: `examples/read-post.json` (content loaded by POST
passes, another POST on the page stays blocked) against `examples/read-post-blocked.json` (the same page without the list shows its error).
`examples/sheet.json` opens a bottom sheet, types in it and uses Back twice (Android: the first Back closes the keyboard, the second the sheet).

**Writes: default NO WRITES.** A flow can press real buttons, so unless the file (or `--allow-writes "<reason>"`) says otherwise:
- Android: one context-level route, installed before any page loads, aborts every non-GET/HEAD/OPTIONS request to ANY origin (public
  runs included), service workers are blocked and every WebSocket is closed. If it cannot be installed the flow does not run. A
  blocked form submission leaves Chrome's blank error page (the request never left), so a flow that submits a form on Android
  continues on that page; a page's own background POSTs just fail. The count and the paths of blocked requests are in the summary.
- iOS (no request interception): a **JavaScript guard, not a block**. It is injected through WebDriver right after each document loads,
  re-checked every 60 ms while ANY step waits (timers, polling, settling) and again right after every step (so a document reached by a tap on a link, Back or
  Enter is guarded before the screenshot and the next step), under a random per-flow property name the page does not know. It stops
  fetch/XHR whose method is not exactly GET/HEAD/OPTIONS (an XHR whose method it never saw counts as a write), `sendBeacon`, form
  submissions whose method is not GET, and WebSockets. **Holes, plainly:** requests made while a document loads (before the guard
  goes in); functions the page captured before the guard (its own references to fetch, XHR or sendBeacon, ofetch/ky-style instances);
  popups and `target=_blank` windows; dedicated workers; `<a ping>`; WebRTC and WebTransport; a clean `fetch` or
  `HTMLFormElement.prototype.submit` taken from an iframe; a capture-phase listener that hides a submit from the guard; a page that
  finds the random marker through `getOwnPropertyNames`. The fixture flow `examples/guard-race.json` (a page that POSTs 1 s after it loads) shows the guard working after a navigating step on iOS, but it is a race against that 1 s timer (passed in some runs, failed in others on the hosted Macs): the proof that the first second of a document is not covered. **iOS flows are for pages whose buttons are safe to press; the iOS guard is never
  "no writes".** The flow summary counts the documents guarded; a document where the guard cannot be installed fails the flow before
  or right after the step that reached it, and a flow without an active guard is an issue.
- `--allow-writes "<reason>"` (or `"allowWrites"` in the file) turns the guard off for the flow run and prints the reason in every
  summary; use it only on a repo's own test paths. The plain page loads of the same call keep their usual behaviour.
- **Write-protected sessions: `KITQA_NO_WRITES=1`** (kit-qa sets it for the minted sessions of paid or admin-capable sites). The client
  then refuses `--allow-writes` and `"allowWrites"` in the file, the flag travels inside the steps (sealed in private mode) so the
  runner refuses too, and **flows run on Android only**: iOS does the plain load-and-scroll screenshots and its summary says that
  flows were not run there and why.

Public mode: the steps are a public workflow input, so every string that travels or is printed (typed and matched texts, notes,
selectors, flow and shot names, the allow-writes reason) must not look like a secret or personal data (the same checks as URLs: tokens, JWTs,
long random strings, e-mail addresses), and a start URL that `checkUrl` refuses is refused. **That check is a heuristic**: a token typed in
short pieces passes, so never put a real secret in a public steps file. Private mode: the steps travel inside the sealed job and the log prints step numbers only.

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
**iOS: writes are not blocked in plain page loads** (Safari offers no request interception): the page's own code can still send
requests with the QA session. Do not call this "read-only" beyond the list above. Flows (see above) add a page-script guard on iOS.

Token-gated sites are entered here too: kit-qa's `exec <site> --mint` hands this tool a session of the same shape (one host-only
cookie, 2 h lifetime, minted per call); nothing in this repo is specific to them, and a real `?token=` URL is still refused.

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

1. Ask each account for its builds: `GET /builds?limit=50&skip=<n>` (newest first; each build has `appId`, `status`,
   `createdAt`, `startedAt`, `finishedAt`; paged until the month starts). Without `appId` the list covers every app of
   the account, which is what the plan's minutes and its one-build-at-a-time limit belong to (an account with other apps
   is counted correctly; a token that cannot see an app cannot count it). The REST docs page only describes `POST
   /builds`; the fields above were read from a real response.
2. Busy = a build whose status is not final (`finished`, `failed`, `canceled`, `timeout`, `skipped`, `warning`) and was
   created less than 4 h ago, or the account was claimed by another app-qa call on this machine less than 3 min ago
   (`pool-claims.json`; the list can lag behind a just-started build). Choosing and claiming happen under one lock file
   (`pool.lock`, exclusive create, stale after 2 min), so two calls at the same moment never take the same account.
3. Minutes used = whole minutes (rounded up per build) from `startedAt` to `finishedAt` (to now while running) of the
   builds started this calendar month, UTC. It is an estimate of the plan's billing month; quota 500
   (`APP_QA_CM_MONTHLY_MINUTES` for all accounts, or `"monthlyMinutes"` in one account's json).
4. Take the **idle account with the most minutes left**, if it has at least **45** left (a build may run 40 min); ties
   go to the lower number. That spreads the month's minutes evenly over the accounts.
5. Every account busy, nearly out of minutes or unreachable (or none configured): **GitHub macOS shards**, never a
   queue. The log says why: `ios lane: GitHub macOS - GitHub macOS shards instead of queueing: #1 busy, #2 only 30 min left`.

`--ios-on github` forces GitHub; `--ios-on codemagic` forces Codemagic (the best account, queueing if all are busy);
`--ios-on codemagic:2` forces account 2. A background iOS run records its account in its state file, so the detached
process polls with the right token; if that account is no longer configured it fails with a message instead of trying
another account's token. The wait always ends: 60 min at most, checked on every pass; a 401/403, or a 404 that outlasts the
first 3 minutes (a build is not readable for a few seconds after it starts), ends it at once with a written failure; network
errors and 5xx are retried until the deadline. Overlapping background runs: each run has its own pending file and result
file (an unread failure is never overwritten; the next call reports every unread one), and a run moves the iOS last pass
only while it still equals what the run was planned against, so a failed run cannot be hidden by a later one. Not done: splitting one `--ios wait` run across two accounts (a second build means a
second native build, doubling its minutes for a modest time gain, and it cannot be tested without spending minutes).

Self-check: `npm test` (the picker and config loader are pure/fake-API tests in `test/app-qa-pool.test.mjs`).

### Home-screen widgets (`--widgets`)

`node bin/app-qa.mjs --app <dir> --widgets all` (or `--widgets NameA,NameB`) adds one step per platform that puts the
app's widgets (the `expo-widgets` plugin in `app.json`) on the device and photographs them; alone it runs only that step,
with `--flows` / `--changed` it runs after the flows. Steps (`runner/app-widgets.mjs`), results in
`<out>/<platform>-widgets-home/` (`widgets/*.png`, `junit.xml`, `widget-host.log`):

1. The app runs once so it writes its widget data: the app's `.maestro/widgets/setup.yaml`, else launch + 20 s.
2. **Android**: the emulator keeps its launchers off (they froze over the app, see `runner/app-android.sh`). A small
   widget host (`runner/widget-host`, plain Java built with the SDK's own tools in a few seconds) gets the bind
   permission (`adb shell appwidget grantbind`) and binds every widget of the app at its `targetCellWidth` x
   `targetCellHeight`, sized as the Android docs' portrait phone cells (73n-16 x 118n-16 dp: 4x2 = 276 x 220 dp, the
   least a launcher grants), on a 4-column page: what you see is the app's real RemoteViews in a real
   `AppWidgetHostView`, light and dark (`cmd uimode night`), and a step fails when a widget sends no views, fails to
   inflate or shows Glance's own "Can't show content" card. Not a launcher: corner clipping and margins differ, and a
   big phone's launcher gives more room than these sizes.
3. **iOS** (Simulator, English): **unproven, not yet seen working** (2026-11-26). The step drives SpringBoard with
   Maestro: hold the first dock icon > Edit Home Screen > Edit > Add Widget > the app > the N-th page > Add Widget for
   each kind and size, then home-screen pages in light, dark and Tinted; lock-screen widgets and Tinted are best effort
   (`skip`, not `FAIL`, when they cannot be driven). StandBy is not covered. What three probes on a GitHub `macos-26`
   runner (iPhone 17 Pro, iOS 26.5) showed: Maestro sees and taps SpringBoard; `longPressOn` does nothing on the home
   screen but a zero-length 2.5 s `swipe` on a dock icon opens its menu with "Edit Home Screen"; `longPressOn` on the
   lock screen opens the wallpaper gallery, Customize opens the editor with "ADD WIDGETS"; `swipe LEFT` did not always
   change the home page; a widget written into `data/Library/SpringBoard/IconState.plist` while the simulator was shut
   down did not appear after boot; `maestro hierarchy` hangs in the lock-screen editor; each Maestro call costs 2-3 min
   of driver start on those runners. Next step for whoever continues: run the step once with `--platforms ios` and read
   `gen/hierarchy-add.json` + `widgets/fail-add.png`.
4. The app's `.maestro/widgets/after.yaml`, if any, runs with the widgets on screen (press a widget button, open the app,
   check it), followed by one more round of screenshots.

### Is device QA worth running at all? (`--changed`)

`--changed` compares the app files with the last passing run of each platform and looks the difference up in the app's
`.maestro/flows-map.json` (`ignore`, `all`, `rules`, `dark`). It then decides, and prints one line saying what and why:
`app-qa: Android 2 flows (01-read, 04-resume); iOS waits for the land/release step (no iOS-specific change)`
(`--lang vi` for Vietnamese, plus a parseable `decision-code:` line; `--plan-only` prints it and stops, nothing packed or started).

1. Only ignored files (tests, docs, maps) or nothing changed: **no run at all**.
2. `--unit-covered a,b` (files a unit test that was green in the same verify run imports directly; the caller proves it):
   coverage never turns an unknown file into a skipped one. An unmapped file means every flow, and a file a rule lists keeps
   its flows on both platforms. Only a covered plain `.ts` module (no JSX, not in `all` or `ignore`) that the map names in
   its explicit `"unitOnly"` globs (empty by default) is dropped from the selection: for those the unit tests are the check.
3. `--ios-when risk` (with `--ios background`): iOS starts now only when something iOS-specific changed since iOS last
   passed: a file matching `ios.paths` in the map, a file whose text matches `ios.content` (safe-area, NativeTabs, Glass,
   fonts ...), a changed flow, or no earlier iOS pass. Otherwise iOS is deferred without moving its snapshot, so the next call
   with `--ios-when always` (the default; a land step or a release) runs every iOS flow for everything changed since the
   last iOS pass: several UI commits share one iOS run. `--ios wait` (a land step, store builds) is a gate: never deferred, and
   it compares with the last pass only (never with a background run's pending content), so a hung or killed background run
   cannot empty its plan. With nothing to run it returns at once without waiting.
