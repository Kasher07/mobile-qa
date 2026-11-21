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
