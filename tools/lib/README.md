# `tools/lib/` — code shared by the developer tools

Node-only helpers for the tools in `tools/`. Nothing here is bundled by
`tools/build_single.mjs`, so the `docs/EXTENDING.md` §0 source constraints do not apply: these are
plain ES modules with ordinary imports.

| file | what |
|---|---|
| `browser.mjs` | the Playwright harness plumbing: find Playwright, serve a directory, launch Chromium with software WebGL, answer the CDN origins from a cache, and always clean both up again |

## `browser.mjs`

`tools/screenshot_app.mjs` and `tools/render_smoke.mjs` both drive a real headless Chromium, and
each of them used to carry its own copy of the same four things — with a different bug in each
(docs/REVIEW.md **D9**). This module is the single version they now share; `tests/tools.test.mjs`
checks that they still import it and that neither has grown its own server again.

```js
import { withHarness } from './lib/browser.mjs';

const failures = await withHarness({ root: repoRoot, width: 1440, height: 900 }, async ({ page, url }) => {
  await page.goto(`${url}/index.html`, { waitUntil: 'networkidle' });
  …
  return checks;
});                              // server and browser are closed here, thrown or not
process.exit(failures.length ? 1 : 0);
```

| export | what it does |
|---|---|
| `loadPlaywright()` | the `playwright` module: the bare import first, then the global install (`npm root -g`), then `playwright-core` |
| `serveDir(root, { port })` | a static server over `root`, resolved once the socket is listening (no sleep race, no `python3` dependency); `port: 0` picks a free port. Returns `{ url, port, close() }`, and `close()` is idempotent |
| `launchChromium(pw, { width, height, … })` | Chromium with SwiftShader WebGL plus one context; closes the browser if the context throws. Remaining options go to `newContext` (`reducedMotion`, `deviceScaleFactor`, `proxy`, …) |
| `fetchCached(url, { cacheDir })` | one cached download: `curl --fail` into `<file>.part`, renamed only on success — a CDN error page can never be cached and later served to the browser as JavaScript, and an interrupted run leaves no half file |
| `routeCdnCache(context, { cacheDir, onMiss })` | serve `cdn.jsdelivr.net` and Google Fonts from that cache. Returns `{ hits, misses }`; a miss means the asset was neither cached nor reachable, so report it rather than let the page load half-dressed |
| `withHarness(opts, fn)` | serve + launch + route, run `fn({ server, browser, context, page, url })`, and close everything in a `finally` — the one place that owns the cleanup, so no harness can leak a browser process and a listening socket on an early failure. `{ page: false }` when the tool opens its own pages |
| `cdnCacheDir()`, `CDN_ORIGINS`, `BROWSER_MIME`, `BROWSER_UA` | the defaults the above use |

Notes:

- The default cache is `os.tmpdir()/tissue-weather-cdn-cache`, so a harness never writes into the
  repository. Pass `cacheDir: join(root, 'dist', 'cdn-cache')` to use the in-repo cache instead (it
  is git-ignored, and `tools/build_single.mjs --vendor` reads it as one of its sources for the
  offline page).
- `serveDir` sets `cache-control: no-store`, serves `index.html` for a directory, and refuses paths
  that escape the served root.
- A new tool that needs a browser should start from `withHarness` rather than a fifth copy of
  `chromium.launch`.

`tests/tools.test.mjs` covers the parts that need no browser: `serveDir` (serves, refuses
traversal, closes twice) and `fetchCached` (caches, never keeps a failed download).
