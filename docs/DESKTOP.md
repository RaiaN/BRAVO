# BRAVO as a macOS app

Same shape as the ModelArk starter kit, because that shape is right for this app.

## Why not a static export

BRAVO's whole model layer is `pages/api/*` — the reasoner, Seedance start/poll,
Seedream, audio, media, the skills library. A static export has no server, so every one
of those routes would 404 and the app would be a shell with nothing behind it.

So the Electron main process **boots Next.js in-process**, serves it on a free
`127.0.0.1` port, and points the window at that URL:

```js
nextServer = next({ dev: false, dir: app.getAppPath() });
await nextServer.prepare();
httpServer = createServer((req, res) => handle(req, res));
```

One process, one app, and the API routes work exactly as they do in `next dev`.

## Running it

```bash
npm run dev:desktop
```

Next dev + the Electron window together, with hot reload. Honours `$PORT`
(`PORT=3210 npm run dev:desktop`) since 3000 is often taken.

```bash
npm run build:desktop
```

`next build`, then `electron-builder -m` → `dist/mac/BRAVO-<version>-arm64.dmg` plus the
`.app` beside it.

```bash
npm run start:desktop
```

The packaged path against the current tree, without building a dmg.

## Two things that had to differ from the starter kit

**`asar: false`.** `pages/api/film/skills.js` resolves the library as
`process.cwd() + '/skills'` — the folder is the source of truth. A
launched `.app` inherits the Finder's cwd (usually `/`), so `electron/main.js` calls
`process.chdir(app.getAppPath())`. `process.chdir` cannot enter an asar archive, so the
app ships unpacked. The kit stays unchanged; the host moves to meet it.

**`.env.local` is not bundled.** `"!**/.env*"` keeps it out of the build: a distributed
`.dmg` carrying an Ark key would bill its author for every copy. The packaged app reads
`.env.local` from the user's own data directory instead:

```
~/Library/Application Support/BRAVO/.env.local
```

In development it reads the repo copy. With no file at all the app still runs — the kit's
routes accept a per-request `apiKey` and `/api/film/config` reports
`hasServerKey: false`, which is the key-less path the starter kit's DEPLOYMENT.md
describes.

## Window chrome

`titleBarStyle: 'hiddenInset'` with `trafficLightPosition: { x: 14, y: 12 }` drops the
traffic lights into the 38px strip the shell already reserves (`--chrome-h`), so the rail
and the thread header run to the top edge. `preload.js` exposes `BRAVO_DESKTOP`, which
adds `body.desktop` and turns that strip into a real `-webkit-app-region: drag` handle —
scoped to the desktop window so it can never swallow a click in a browser tab.
`backgroundColor` follows `nativeTheme` so the window never flashes white before the
first paint.

## Signing

Unsigned. `hardenedRuntime` is on with `electron/entitlements.mac.plist` (JIT for V8,
network client for the Ark/TOS/voice calls), but there is no Developer ID, so Gatekeeper
will quarantine a downloaded `.dmg`. For a real release, add
`CSC_LINK`/`CSC_KEY_PASSWORD` and notarisation. Locally, right-click → Open.
