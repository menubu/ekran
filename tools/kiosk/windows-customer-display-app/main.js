const path = require('node:path');
const { URL } = require('node:url');
const { app, BrowserWindow, screen, session, globalShortcut } = require('electron');

const APP_DISPLAY_NAME = 'MenuBu Desktop';
const CUSTOMER_WINDOW_TITLE = 'MenuBu Desktop - Musteri Ekrani';
const PROTOCOL_NAME = 'menubu-display';
const DEFAULT_PANEL_URL = 'https://www.menubu.tr/panel';
const DEFAULT_CUSTOMER_URL = 'https://menubu.tr/panel/order_customer_display.php?popup=1&autofs=1';

const KIOSK_MODE = process.argv.includes('--kiosk') || String(process.env.MENUBU_KIOSK || '') === '1';
const HARD_LOCK_MODE = process.argv.includes('--hard-lock') || String(process.env.MENUBU_HARD_LOCK || '') === '1';

let mainWindow = null;
let customerWindow = null;
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

function resolvePanelUrl() {
  const envUrl = String(process.env.MENUBU_PANEL_URL || '').trim();
  if (isHttpUrl(envUrl)) return envUrl;

  const cliUrl = getArgValue('--panel-url=');
  if (isHttpUrl(cliUrl)) return cliUrl;

  return DEFAULT_PANEL_URL;
}

function resolveCustomerDisplayUrl(preferredUrl = '') {
  if (isHttpUrl(preferredUrl)) return preferredUrl;

  const envUrl = String(process.env.MENUBU_CUSTOMER_URL || '').trim();
  if (isHttpUrl(envUrl)) return envUrl;

  const customerCliUrl = getArgValue('--customer-url=');
  if (isHttpUrl(customerCliUrl)) return customerCliUrl;

  const legacyCliUrl = getArgValue('--url=');
  if (isHttpUrl(legacyCliUrl)) return legacyCliUrl;

  return DEFAULT_CUSTOMER_URL;
}

function getDisplayLayout() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!Array.isArray(displays) || displays.length === 0) {
    return {
      hasSecondary: false,
      primaryBounds: { x: 0, y: 0, width: 1366, height: 768 },
      customerBounds: { x: 0, y: 0, width: 1280, height: 800 }
    };
  }

  const secondary = displays.find((d) => d && d.id !== primary.id);
  const primaryBounds = primary.bounds || { x: 0, y: 0, width: 1366, height: 768 };
  const customerTarget = secondary || primary;
  const customerBounds = customerTarget.bounds || primaryBounds;

  return {
    hasSecondary: Boolean(secondary),
    primaryBounds: {
      x: Number(primaryBounds.x) || 0,
      y: Number(primaryBounds.y) || 0,
      width: Math.max(1024, Number(primaryBounds.width) || 1366),
      height: Math.max(640, Number(primaryBounds.height) || 768)
    },
    customerBounds: {
      x: Number(customerBounds.x) || 0,
      y: Number(customerBounds.y) || 0,
      width: Math.max(640, Number(customerBounds.width) || 1280),
      height: Math.max(480, Number(customerBounds.height) || 800)
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

function forceCustomerFullscreenState(win) {
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

function applyCustomerDisplayLock(win) {
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

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function openCustomerDisplayWindow(targetUrl = '') {
  const customerUrl = resolveCustomerDisplayUrl(targetUrl);
  const layout = getDisplayLayout();
  const bounds = layout.customerBounds;
  const secondaryDisplayLock = layout.hasSecondary;
  const nativeKioskMode = KIOSK_MODE && !secondaryDisplayLock;

  if (customerWindow && !customerWindow.isDestroyed()) {
    customerWindow.show();
    customerWindow.focus();

    if (secondaryDisplayLock) {
      customerWindow.__targetBounds = bounds;
      applyCustomerDisplayLock(customerWindow);
    }

    customerWindow.loadURL(customerUrl).catch((err) => {
      console.error('Failed to reload customer display URL:', err);
    });

    if (KIOSK_MODE && customerWindow.__nativeKioskMode) {
      forceCustomerFullscreenState(customerWindow);
    }

    return;
  }

  customerWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    title: CUSTOMER_WINDOW_TITLE,
    backgroundColor: '#000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: nativeKioskMode,
    fullscreen: nativeKioskMode,
    kiosk: nativeKioskMode,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  customerWindow.setMenuBarVisibility(false);
  customerWindow.setTitle(CUSTOMER_WINDOW_TITLE);
  customerWindow.__nativeKioskMode = nativeKioskMode;
  customerWindow.__secondaryDisplayLock = secondaryDisplayLock;
  customerWindow.__targetBounds = bounds;

  customerWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    if (!customerWindow || customerWindow.isDestroyed()) return;
    customerWindow.setTitle(CUSTOMER_WINDOW_TITLE);
  });

  customerWindow.once('ready-to-show', () => {
    customerWindow.show();
    customerWindow.setTitle(CUSTOMER_WINDOW_TITLE);
    customerWindow.focus();

    if (customerWindow.__secondaryDisplayLock) {
      applyCustomerDisplayLock(customerWindow);
    }

    if (KIOSK_MODE && customerWindow.__nativeKioskMode) {
      forceCustomerFullscreenState(customerWindow);
    }
  });

  if (KIOSK_MODE && HARD_LOCK_MODE && customerWindow.__nativeKioskMode) {
    customerWindow.on('leave-full-screen', () => {
      setTimeout(() => forceCustomerFullscreenState(customerWindow), 50);
    });
  }

  if (customerWindow.__secondaryDisplayLock) {
    customerWindow.on('move', () => {
      setTimeout(() => applyCustomerDisplayLock(customerWindow), 30);
    });
    customerWindow.on('resize', () => {
      setTimeout(() => applyCustomerDisplayLock(customerWindow), 30);
    });
  }

  customerWindow.on('closed', () => {
    customerWindow = null;
  });

  customerWindow.webContents.on('did-finish-load', () => {
    if (!customerWindow || customerWindow.isDestroyed()) return;

    if (customerWindow.__secondaryDisplayLock) {
      applyCustomerDisplayLock(customerWindow);
    }

    if (KIOSK_MODE && customerWindow.__nativeKioskMode) {
      forceCustomerFullscreenState(customerWindow);
    }
  });

  customerWindow.loadURL(customerUrl).catch((err) => {
    console.error('Failed to load customer display URL:', err);
  });
}

function handleProtocolInvocation(rawProtocolUrl) {
  const nextUrl = parseProtocolTarget(rawProtocolUrl);
  if (isHttpUrl(nextUrl)) {
    pendingProtocolTargetUrl = nextUrl;
  }

  if (app.isReady()) {
    openCustomerDisplayWindow(nextUrl);
    focusMainWindow();
  }
}

function createMainWindow() {
  const layout = getDisplayLayout();
  const bounds = layout.primaryBounds;

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#ffffff',
    frame: true,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.setTitle(APP_DISPLAY_NAME);
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setTitle(APP_DISPLAY_NAME);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.setTitle(APP_DISPLAY_NAME);
    if (!mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${PROTOCOL_NAME}://`)) return;

    event.preventDefault();
    handleProtocolInvocation(url);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${PROTOCOL_NAME}://`)) {
      handleProtocolInvocation(url);
      return { action: 'deny' };
    }

    return { action: 'allow' };
  });

  mainWindow.loadURL(resolvePanelUrl()).catch((err) => {
    console.error('Failed to load panel URL:', err);
  });
}

function registerEmergencyShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit();
  });

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (!customerWindow || customerWindow.isDestroyed()) return;

    try {
      customerWindow.setKiosk(false);
      customerWindow.setFullScreen(false);
      setSimpleFullscreenIfSupported(customerWindow, false);
      customerWindow.focus();
    } catch (_) {
      // no-op
    }
  });
}

pendingProtocolTargetUrl = parseProtocolTarget(getProtocolArg(process.argv));
app.setName(APP_DISPLAY_NAME);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolArg = getProtocolArg(argv);
    if (protocolArg) {
      handleProtocolInvocation(protocolArg);
      return;
    }

    focusMainWindow();
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
    handleProtocolInvocation(rawUrl);
  });

  app.whenReady().then(() => {
    registerProtocolClient();
    setupPermissions();
    registerEmergencyShortcuts();
    createMainWindow();

    if (isHttpUrl(pendingProtocolTargetUrl)) {
      openCustomerDisplayWindow(pendingProtocolTargetUrl);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}
