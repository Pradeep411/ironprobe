# Security model

IronProbe sends real traffic, so it fails closed.

## What is enforced
1. **Host allow-list (required).** Every API request and redirect hop, every crawl link and every
   load-test request is checked against `allowedHosts`. Patterns: `example.com`, `*.example.com`,
   `localhost:3000` (port-specific), `[::1]:8080`. Wildcards over shared suffixes (`*.com`,
   `*.co.uk`) are refused.
   **Browsers** get two layers. Each browser IronProbe starts sends all of its traffic, localhost
   included, through a small allow-list proxy on 127.0.0.1, so every connection is checked: page
   loads, every hop of a redirect chain, fetch/XHR, streams, scripts, images, fonts and WebSockets.
   On top of that, a request guard fails the test on any off-list page load and blocks off-list
   files unless listed in `ui.allowAssetHosts` (files may load from those hosts; pages may not).
   WebRTC is limited to proxied traffic, so it cannot send UDP around the proxy. Only `http(s)`
   is allowed, plus `chrome-extension://` for the extension you load.
2. **Credentials never cross origins.** API redirects to a different origin drop `Authorization`
   and `Cookie` headers.
3. **Load tests** run only with `iOwnThisTarget: true` (not set by `ironprobe init`) and are capped at
   50 workers, 120 seconds and 200 requests/second.
4. **Fuzzing** is generated for GET/HEAD only. Writes are generated only with `includeWrites: true`.
5. **No code from imports runs.** Postman scripts are never executed; common assertions are translated
   by pattern and the rest are listed for review.
6. **Secrets.** Use `{{env.NAME}}`. Environment values, names listed in `secretEnv` and captured tokens
   are masked as `***` in logs, `results.json`, `junit.xml` and the report, including URL-encoded and
   base64 forms. Headers such as `Authorization`, `Cookie` and anything named like a token, key, secret
   or session are always masked. `ironprobe scan` (and every run) flags hard-coded secrets.
7. **Reports** contain no scripts and load nothing from the internet. All text and numbers are escaped,
   data coming from tested pages is validated before use, and a strict Content-Security-Policy is set.
8. **Regex checks** run on V8's linear-time engine, which cannot backtrack, so no pattern can hang
   a run. Patterns that engine cannot run (such as back-references to groups and lookaheads) are
   reported as config errors.
   Inputs over 10,000 characters are refused. Retries are capped at 5.
9. **Paths.** `output` and `ui.baselineDir` must stay inside the project folder.
10. **No telemetry.** Besides your targets, IronProbe only downloads its test browsers from Playwright's servers (once, the first time). In quick mode the page under test may also load its own public files, as in a normal visit.
11. **Crawling** stays on the start origin, skips logout/delete-style links and is capped at 100 pages.

## Dashboard and quick mode
- The dashboard listens on 127.0.0.1 only, rejects other Host headers (DNS rebinding) and other
  origins, and needs a random token created each time it starts. Starting a test needs the token in
  a request header, so another website cannot trigger one. Reports are served with a strict CSP.
- Quick mode only navigates, crawls and calls APIs on the host you typed (plus its www/bare twin).
  Like a normal visit, the page may load its own files (scripts, fonts, images) from other hosts.
- Dropped files are parsed as data (JSON/YAML) and never executed. An API token typed in the
  dashboard is passed in memory, masked in all outputs and never written to disk.
- Run history is stored in `~/.ironprobe` (or `IRONPROBE_HOME`). Screenshots in it show your pages.
- Page files from hosts you did not type are refused if the host resolves to a private, loopback,
  link-local (cloud metadata) or other reserved address, including IPv6 forms that wrap one; the
  proxy connects to the address it checked, so DNS cannot change in between. Common analytics and ad
  hosts are skipped. Postman requests that change data are skipped unless you tick the option.
- Files are written readable by your user only, and dropped files are deleted after each run.
  Each site allows one run at a time.

## What it does not protect against
- **Quick mode on localhost** lets the page use any port on the host you typed (your app's API often
  runs on a second port). The dashboard itself still needs its private token.
- **Quick mode redirects to public sites.** Over https the proxy cannot tell a page load from a file,
  so if your page redirects to another public website, that request is sent; the run marks it as a
  failure. Private addresses stay blocked.
- **Screenshots and traces** show what was on screen and are not masked. Keep test accounts free of
  real personal data, and treat `ironprobe-report/artifacts` as sensitive.
- **DNS rebinding.** Host names are checked, not IP addresses. Use hosts whose DNS you control.
- **Chrome extension runs** share one browser profile across tests (Chrome requires it for extensions).
- **Redirects onto asset hosts.** A redirect from an allowed host to a host listed only in
  `ui.allowAssetHosts` is let through by the proxy (it cannot tell pages from files). If it was a
  page load, the test still fails with "blocked", but that one request has been sent.
- **Browser features outside HTTP.** DNS prefetching is switched off in Chromium and Firefox, but
  the browser still resolves allowed host names itself. WebKit may send localhost traffic directly
  instead of through the proxy, so off-list local ports are only stopped by the request guard there.
- **Extension background code.** A Chrome extension's service worker uses the same proxy, so its
  requests are checked too, but they are not attributed to a specific test.
- **Timings** include about a millisecond per request added by the local proxy.

## Using IronProbe with AI agents
The plugin's agents treat everything from the app under test (results, responses, page text,
console output) as data, never as instructions, and only edit test suites and config unless you ask.

Report vulnerabilities privately to the maintainers before public disclosure.
