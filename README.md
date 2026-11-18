# mobile-qa

Real-phone screenshots of public web pages, run on GitHub Actions:

- **iOS**: Safari on the iOS Simulator (macOS runner), driven by `safaridriver`; screenshots of the whole device screen.
- **Android**: Chrome on the Android emulator (Linux runner, KVM), driven by Playwright's Android API; device screenshots.

Each page gets up to N scroll positions, a layout probe (horizontal overflow and the elements causing it, small tap
targets, viewport meta, HTTP status) and, on Android, JS errors, console errors and failed requests.

```bash
node bin/mobile-qa.mjs https://example.com https://example.com/pricing [--platforms ios,android] [--out DIR]
```

Self-check: `npm test`; fixtures at https://kasher07.github.io/mobile-qa/; fault paths with `MOBILE_QA_TEST_STARVE_IOS=1`,
`MOBILE_QA_TEST_FAULT=android-setup` and `--ios-mode openurl`.

The client dispatches `.github/workflows/mobile-qa.yml`, waits, downloads the artifacts and deletes the run, so URLs
and screenshots do not stay public. Only public URLs are accepted (no localhost, private IPs, credentials or
secret-looking query parameters).
