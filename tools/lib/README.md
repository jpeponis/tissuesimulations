# `tools/lib/` — code shared by the developer tools

Node-only helpers for the tools in `tools/`. Nothing here is bundled by
`tools/build_single.mjs`, so the `docs/EXTENDING.md` §0 source constraints do not apply: these are
plain ES modules with ordinary imports.

| file | what |
|---|---|
| `browser.mjs` | the Playwright harness plumbing: find Playwright, serve a directory, launch Chromium with software WebGL, answer the CDN origins from a cache, and always clean both up again |

## `browser.mjs` — migration note for `screenshot_app.mjs` and `render_smoke.mjs`

Both harnesses grew their own copy of the same four things, and each copy has a bug the other does
not (docs/REVIEW.md **D9**). `browser.mjs` is the single version; adopting it is a mechanical
edit, and it is deliberately left to the owners of those two files:

| what the tool does today | replace with | what that fixes |
|---|---|---|
| its own `loadPlaywright()` (bare import → `npm root -g`) | `loadPlaywright()` | one copy; also tries `playwright-core` |
| `spawn('python3', ['-m', 'http.server', …])` + `await sleep(700)` (`screenshot_app.mjs`) | `await serveDir(root, { port: 0 })` | no python dependency, no sleep race, a free port every time, and `server.close()` instead of `server.kill()` |
| `startServer()` (`render_smoke.mjs`) | `await serveDir(root, { port })` | same code, one place; `port: 0` picks a free port |
| `chromium.launch({ args: [swiftshader…] })` + `newContext({ viewport })` | `await launchChromium(null, { width, height })` | identical flags in both harnesses; closes the browser if the context throws |
| `cached(url)` / `cdnCached(url)` + `context.route(origin + '/**', …)` | `await routeCdnCache(context, { cacheDir })` | `curl --fail` (a 404 page can no longer be cached and served as JavaScript), download to `<file>.part` and rename only on success, and the cache lives in `os.tmpdir()` instead of `dist/cdn-cache` |
| `await browser.close(); server.kill();` at the end of the script | wrap the run in `await withHarness({ root, width, height }, async ({ page, url }) => { … })` | an exception anywhere in the middle no longer leaks a browser process and a listening socket |

```js
import { withHarness } from './lib/browser.mjs';

const failures = await withHarness({ root: repoRoot, width: 1440, height: 900 }, async ({ page, url }) => {
  await page.goto(`${url}/index.html`, { waitUntil: 'networkidle' });
  …
  return checks;
});                              // server and browser are closed here, thrown or not
process.exit(failures.length ? 1 : 0);
```

Notes for the migration:

- `serveDir` sets `cache-control: no-store` and serves `index.html` for a directory, like both
  current servers do. It refuses paths that escape the served root.
- `routeCdnCache` returns `{ hits, misses }`. A miss means the asset was neither cached nor
  reachable — report it rather than letting the page load half-dressed. Pass `onMiss` to collect
  them into the harness's own problem list instead of `console.error`.
- The default cache is `os.tmpdir()/tissue-weather-cdn-cache`. Pass
  `cacheDir: join(root, 'dist', 'cdn-cache')` to keep using the in-repo cache (it is git-ignored,
  and `tools/build_single.mjs --vendor` reads it as one of its sources for the offline page).
- `launchChromium` takes the remaining `newContext` options through (`reducedMotion`,
  `deviceScaleFactor`, `proxy`, …), so a harness that needs `--proxy` or reduced motion keeps
  passing exactly what it passes today.
- `withHarness({ page: false })` when the tool wants to open several pages itself.

`tests/tools.test.mjs` covers the parts that need no browser: `serveDir` (serves, refuses
traversal, closes) and `fetchCached` (caches, never keeps a failed download).
