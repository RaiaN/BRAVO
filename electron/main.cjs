// BRAVO as a macOS app.
//
// The window does NOT load a static export — it boots Next.js IN-PROCESS and loads it
// over 127.0.0.1. That is not a detail: BRAVO's entire model layer is `pages/api/*`
// (§10), so the app needs a live Node server behind it. A static export would ship the
// shell with nothing to talk to.
//
// Same approach as the ModelArk starter kit; the differences are BRAVO's macOS chrome,
// where the API key is read from, and making `.agents/skills` reachable once packaged.

const path = require('path');
const fs = require('fs');
const net = require('net');
const { createServer } = require('http');
const { app, BrowserWindow, nativeTheme, shell } = require('electron');
const next = require('next');

const isDev = !app.isPackaged;

// The dev server's CA requirement (§10) applies to the packaged app too — its API routes
// make the same outbound TLS calls. Node reads this lazily, when the root store is first
// built, which is long after this line runs.
if (!process.env.NODE_USE_SYSTEM_CA) process.env.NODE_USE_SYSTEM_CA = '1';

// ---- credentials -----------------------------------------------------------------
// A distributed .app must not carry anyone's Ark key, so `.env.local` is NOT bundled.
// The packaged app reads it from the user's own data directory; in development the repo
// copy is used. Loaded into process.env BEFORE Next prepares — Next never overwrites a
// variable that is already set, so this layer wins.
const loadEnv = () => {
  const candidates = isDev
    ? [path.join(app.getAppPath(), '.env.local')]
    : [path.join(app.getPath('userData'), '.env.local')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;                                  // comment or blank
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    return file;
  }
  return null;
};

const findOpenPort = (startPort) => new Promise((resolve) => {
  const tryPort = (port) => {
    const tester = net.createServer()
      .once('error', () => tryPort(port + 1))
      .once('listening', () => tester.close(() => resolve(port)))
      .listen(port, '127.0.0.1');
  };
  tryPort(startPort);
});

let nextServer;
let httpServer;
let mainWindow;

const createMainWindow = async () => {
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // The shell reserves a 38px strip at the top (--chrome-h) with nothing interactive
    // in it. Hide the title bar and drop the traffic lights into that strip: the rail
    // and the thread header run to the top edge, the way Claude's desktop app does.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    // Paint the canvas colour immediately so the window does not flash white before the
    // first render.
    backgroundColor: dark ? '#262624' : '#faf9f5',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Anything that is not this app opens in the real browser, not in a chrome-less window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.BRAVO_DEV_URL || 'http://localhost:3000');
    return;
  }

  const appDir = app.getAppPath();

  // `pages/api/film/skills.js` resolves the library as `process.cwd()/.agents/skills`
  // (§7: the FOLDER is the source of truth). A launched .app inherits whatever cwd the
  // Finder had — usually `/` — so without this the skills library is silently empty.
  // The kit is unchanged (§10); the host moves to meet it.
  try { process.chdir(appDir); } catch { /* fall through — skills will report empty */ }

  const port = await findOpenPort(3000);
  nextServer = next({ dev: false, dir: appDir });
  const handle = nextServer.getRequestHandler();
  await nextServer.prepare();

  httpServer = createServer((req, res) => handle(req, res));
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.whenReady().then(() => {
  const envFile = loadEnv();
  if (!envFile) {
    // Not fatal: the transport kit's routes accept a per-request apiKey and
    // /api/film/config reports `hasServerKey: false`, so the app runs key-less.
    console.warn(`[bravo] no .env.local found — expected at ${isDev ? app.getAppPath() : app.getPath('userData')}`);
  }
  return createMainWindow();
});

app.on('before-quit', async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (nextServer) await nextServer.close();
});
