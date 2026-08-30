const path = require('path');
const fs = require('fs');
const net = require('net');
const { createServer } = require('http');
const { app, BrowserWindow, nativeTheme, shell } = require('electron');
const next = require('next');

const isDev = !app.isPackaged;

const CERT_ERR = /UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_|unable to (get|verify)/i;

const tlsIsIntercepted = async () => {
  if (process.env.NODE_USE_SYSTEM_CA) return false;
  const base = process.env.MODELARK_API_BASE_URL;
  if (!base) return false;
  try {
    await fetch(base, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
    return false;
  } catch (err) {
    const code = String(err?.cause?.code || err?.code || err?.message || '');
    return CERT_ERR.test(code);
  }
};

const loadEnv = () => {
  const candidates = isDev
    ? [path.join(app.getAppPath(), '.env.local')]
    : [path.join(app.getPath('userData'), '.env.local')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: dark ? '#262624' : '#faf9f5',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.BRAVO_DEV_URL || 'http://localhost:3000');
    return;
  }

  const appDir = app.getAppPath();

  try { process.chdir(appDir); } catch { }

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

app.whenReady().then(async () => {
  const envFile = loadEnv();

  if (await tlsIsIntercepted()) {
    console.warn('[bravo] TLS is intercepted on this network — relaunching with NODE_USE_SYSTEM_CA=1');
    process.env.NODE_USE_SYSTEM_CA = '1';
    app.relaunch();
    app.exit(0);
    return undefined;
  }

  if (!envFile) {
    console.warn(`[bravo] no .env.local found — expected at ${isDev ? app.getAppPath() : app.getPath('userData')}`);
  }
  return createMainWindow();
});

app.on('before-quit', async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (nextServer) await nextServer.close();
});
