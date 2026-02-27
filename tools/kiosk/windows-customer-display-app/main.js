const path = require('node:path');
const { URL } = require('node:url');
const { app, BrowserWindow, screen, session, globalShortcut } = require('electron');

const PROTOCOL_NAME = 'menubu-display';
const DEFAULT_URL = 'https://menubu.tr/panel/order_customer_display.php?popup=1&autofs=1';

const KIOSK_MODE = process.argv.includes('--kiosk') || String(process.env.MENUBU_KIOSK || '') === '1';
const HARD_LOCK_MODE = process.argv.includes('--hard-lock') || String(process.env.MENUBU_HARD_LOCK || '') === '1';

let mainWindow = null;
let pendingProtocolTargetUrl = '';

function getArgValue(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix));
  if (!arg) return '';
  return String(arg.slice(prefix.length)).trim();
}

function isHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function parseProtocolTarget(rawProtocolUrl) {
  if (!rawProtocolUrl || typeof rawProtocolUrl !== 'string') return '';

  try {
    const parsed = new URL(rawProtocolUrl);
    if (parsed.protocol !== `${PROTOCOL_NAME}:`) return '';

    const qUrl = parsed.searchParams.get('url') || parsed.searchParams.get('target') || parsed.searchParams.get('u');
    if (isHttpUrl(qUrl)) return qUrl;

    const candidate = decodeURIComponent(`${parsed.hostname || ''}${parsed.pathname || ''}`.replace(/^\/+/, ''));
    if (isHttpUrl(candidate)) return candidate;

    return '';
  } catch (_) {
    return '';
  }
}

function getProtocolArg(argvList) {
  if (!Array.isArray(argvList)) return '';
  return argvList.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL_NAME}://`)) || '';
}

function resolveCustomerDisplayUrl() {
  if (isHttpUrl(pendingProtocolTargetUrl)) return pendingProtocolTargetUrl;

  const envUrl = String(process.env.MENUBU_CUSTOMER_URL || '').trim();
  if (isHttpUrl(envUrl)) return envUrl;

  const cliUrl = getArgValue('--url=');
  if (isHttpUrl(cliUrl)) return cliUrl;

  return DEFAULT_URL;
}

function getDisplayLayout() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!Array.isArray(displays) || displays.length === 0) {
    return {
      hasSecondary: false,
      bounds: { x: 0, y: 0, width: 1280, height: 800 }
    };
  }

  const secondary = displays.find((d) => d && d.id !== primary.id);
  const target = secondary || primary;
  const bounds = target && target.bounds ? target.bounds : primary.bounds;

  return {
    hasSecondary: !!secondary,
    bounds: {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Math.max(640, Number(bounds.width) || 1280),
      height: Math.max(480, Number(bounds.height) || 800)
    }
  };
}

function setSimpleFullscreenIfSupported(win, value) {
  if (process.platform !== 'darwin') return;
  try {
    win.setSimpleFullScreen(Boolean(value));
  } catch (_) {
    // no-op
  }
}

function forceFullscreenState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (KIOSK_MODE && win.__nativeKioskMode) {
      if (!win.isKiosk()) win.setKiosk(true);
      if (!win.isFullScreen()) win.setFullScreen(true);
      setSimpleFullscreenIfSupported(win, true);
    }
  } catch (_) {
    // no-op
  }
}

function applySecondaryDisplayLock(win) {
  if (!win || win.isDestroyed() || !win.__secondaryDisplayLock) return;

  const bounds = win.__targetBounds || { x: 0, y: 0, width: 1280, height: 800 };

  try {
    win.setKiosk(false);
    win.setFullScreen(false);
    setSimpleFullscreenIfSupported(win, false);
  } catch (_) {
    // no-op
  }

  try {
    win.setBounds(bounds, false);
    win.setPosition(bounds.x, bounds.y, false);
    win.setSize(bounds.width, bounds.height, false);
  } catch (_) {
    // no-op
  }
}

function focusAndReloadIfNeeded(targetUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.show();
  mainWindow.focus();

  if (mainWindow.__secondaryDisplayLock) {
    applySecondaryDisplayLock(mainWindow);
  }

  if (isHttpUrl(targetUrl)) {
    mainWindow.loadURL(targetUrl).catch((err) => {
      console.error('Failed to load protocol target URL:', err);
    });
  }
}

function registerProtocolClient() {
  if (process.platform !== 'win32') return;

  try {
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL_NAME);
    }
  } catch (err) {
    console.error('Protocol registration failed:', err);
  }
}

function setupPermissions() {
  session.defaultSession.setPermissionCheckHandler(() => true);
}

function registerEmergencyShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit();
  });

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
      setSimpleFullscreenIfSupported(mainWindow, false);
      mainWindow.focus();
    } catch (_) {
      // no-op
    }
  });
}

function createWindow() {
  const layout = getDisplayLayout();
  const bounds = layout.bounds;
  const secondaryDisplayLock = layout.hasSecondary;
  const nativeKioskMode = KIOSK_MODE && !secondaryDisplayLock;

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    backgroundColor: '#000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    fullscreenable: nativeKioskMode,
    fullscreen: nativeKioskMode,
    kiosk: nativeKioskMode,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.__nativeKioskMode = nativeKioskMode;
  mainWindow.__secondaryDisplayLock = secondaryDisplayLock;
  mainWindow.__targetBounds = bounds;

  const customerUrl = resolveCustomerDisplayUrl();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();

    if (mainWindow.__secondaryDisplayLock) {
      applySecondaryDisplayLock(mainWindow);
    }

    if (KIOSK_MODE && mainWindow.__nativeKioskMode) {
      forceFullscreenState(mainWindow);
    }
  });

  if (KIOSK_MODE && HARD_LOCK_MODE && mainWindow.__nativeKioskMode) {
    mainWindow.on('leave-full-screen', () => {
      setTimeout(() => forceFullscreenState(mainWindow), 50);
    });
  }

  if (mainWindow.__secondaryDisplayLock) {
    mainWindow.on('move', () => {
      setTimeout(() => applySecondaryDisplayLock(mainWindow), 30);
    });
    mainWindow.on('resize', () => {
      setTimeout(() => applySecondaryDisplayLock(mainWindow), 30);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (mainWindow.__secondaryDisplayLock) {
      applySecondaryDisplayLock(mainWindow);
    }

    if (KIOSK_MODE && mainWindow.__nativeKioskMode) {
      forceFullscreenState(mainWindow);
    }
  });

  mainWindow.loadURL(customerUrl).catch((err) => {
    console.error('Failed to load customer display URL:', err);
  });
}

pendingProtocolTargetUrl = parseProtocolTarget(getProtocolArg(process.argv));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolArg = getProtocolArg(argv);
    const nextUrl = parseProtocolTarget(protocolArg);
    if (isHttpUrl(nextUrl)) {
      pendingProtocolTargetUrl = nextUrl;
      focusAndReloadIfNeeded(nextUrl);
      return;
    }

    focusAndReloadIfNeeded('');
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch (_) {
      // no-op
    }
  });

  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    const nextUrl = parseProtocolTarget(rawUrl);
    if (!isHttpUrl(nextUrl)) return;

    pendingProtocolTargetUrl = nextUrl;
    focusAndReloadIfNeeded(nextUrl);
  });

  app.whenReady().then(() => {
    registerProtocolClient();
    setupPermissions();
    registerEmergencyShortcuts();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}
