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

Shows the signed-in pages on the real phones. Only paths on the site's own origin are accepted (a full URL on another
host, credentials or a token site are refused). The 2 h QA Agent session cookies of that host (not `QA_AGENT_KEY`) are
sealed with a fresh AES-256-GCM key kept in the repo secret `PRIVATE_QA_KEY` (set through stdin, one private run at a
time) and only ciphertext is sent as the workflow input `private_job`. The runner sets the cookies (Android:
`context.addCookies`; iOS: WebDriver Add Cookie on the open origin), only loads and scrolls (Android also aborts
same-origin non-GET requests and counts them), prints page numbers only in its log, and seals every result before
upload. The client unseals locally, scans the run log and the raw artifact for the host name and cookie values, deletes
the run and replaces the secret with random bytes (also on failure or Ctrl-C; leftovers are swept on the next call).
The QA session is not logged out (that would kill it for other kit-qa users): it expires by itself within 2 h.
`MOBILE_QA_REF=<branch>` runs that branch's workflow (to test before merging).

Self-check: `npm test`; fixtures at https://kasher07.github.io/mobile-qa/; fault paths with `MOBILE_QA_TEST_STARVE_IOS=1`,
`MOBILE_QA_TEST_FAULT=android-setup` and `--ios-mode openurl`.

The client dispatches `.github/workflows/mobile-qa.yml`, waits, downloads the artifacts and deletes the run, so URLs
and screenshots do not stay public. Only public URLs are accepted (no localhost, private IPs, credentials or
secret-looking query parameters).
