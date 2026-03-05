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
const LOCAL_NETWORK_COMPAT_MODE = String(process.env.MENUBU_ALLOW_LOCAL_NETWORK || '1') !== '0'
  && !process.argv.includes('--strict-local-network');
const LOCAL_NETWORK_DISABLE_FEATURES = [
  'BlockInsecurePrivateNetworkRequests',
  'PrivateNetworkAccessSendPreflights',
  'PrivateNetworkAccessRespectPreflightResults'
];
const MAIN_ZOOM_STORAGE_KEY = 'menubu_desktop_main_zoom_factor';
const MAIN_ZOOM_MIN = 0.7;
const MAIN_ZOOM_MAX = 1.6;
const MAIN_ZOOM_STEP = 0.1;
const MAIN_ZOOM_DEFAULT = 1;

let mainWindow = null;
let customerWindow = null;
let pendingProtocolTargetUrl = '';
let mainZoomFactor = MAIN_ZOOM_DEFAULT;

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

function parseProtocolCommand(rawProtocolUrl) {
  if (!rawProtocolUrl || typeof rawProtocolUrl !== 'string') return null;
  try {
    const parsed = new URL(rawProtocolUrl);
    if (parsed.protocol !== `${PROTOCOL_NAME}:`) return null;

    const actionRaw = String(
      parsed.searchParams.get('action')
      || parsed.searchParams.get('cmd')
      || parsed.hostname
      || parsed.pathname
      || ''
    ).replace(/^\/+/, '').trim().toLowerCase();

    if (!actionRaw) return null;

    const action = actionRaw.replace(/_/g, '-');
    if (action === 'zoom-in') return { type: 'zoom', op: 'in' };
    if (action === 'zoom-out') return { type: 'zoom', op: 'out' };
    if (action === 'zoom-reset') return { type: 'zoom', op: 'reset' };
    if (action === 'zoom-set') {
      const factorRaw = parsed.searchParams.get('factor');
      const factor = Number(factorRaw);
      if (!Number.isFinite(factor)) return null;
      return { type: 'zoom', op: 'set', factor };
    }

    return null;
  } catch (_) {
    return null;
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

function appendFeatureSwitch(switchName, features) {
  if (!Array.isArray(features) || features.length === 0) return;
  const existingRaw = String(app.commandLine.getSwitchValue(switchName) || '').trim();
  const existing = existingRaw === '' ? [] : existingRaw.split(',').map((item) => item.trim()).filter(Boolean);
  const merged = Array.from(new Set([...existing, ...features]));
  if (merged.length > 0) {
    app.commandLine.appendSwitch(switchName, merged.join(','));
  }
}

function isPrivateIpv4Host(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(hostname || '').trim());
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isLocalNetworkHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  return isPrivateIpv4Host(host);
}

function isLocalNetworkUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? isLocalNetworkHost(parsed.hostname)
      : false;
  } catch (_) {
    return false;
  }
}

function setupLocalNetworkCompatibility() {
  if (!LOCAL_NETWORK_COMPAT_MODE) return;
  appendFeatureSwitch('disable-features', LOCAL_NETWORK_DISABLE_FEATURES);
  app.commandLine.appendSwitch('allow-insecure-localhost');
  app.commandLine.appendSwitch('ignore-certificate-errors');
}

function clampMainZoomFactor(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MAIN_ZOOM_DEFAULT;
  return Math.max(MAIN_ZOOM_MIN, Math.min(MAIN_ZOOM_MAX, numeric));
}

function applyMainZoomFactor(value) {
  mainZoomFactor = clampMainZoomFactor(value);
  if (!mainWindow || mainWindow.isDestroyed()) return mainZoomFactor;
  try {
    mainWindow.webContents.setZoomFactor(mainZoomFactor);
  } catch (_) {
    // no-op
  }
  return mainZoomFactor;
}

function handleMainZoomCommand(command) {
  if (!command || command.type !== 'zoom') return;
  if (command.op === 'in') {
    applyMainZoomFactor(mainZoomFactor + MAIN_ZOOM_STEP);
    return;
  }
  if (command.op === 'out') {
    applyMainZoomFactor(mainZoomFactor - MAIN_ZOOM_STEP);
    return;
  }
  if (command.op === 'reset') {
    applyMainZoomFactor(MAIN_ZOOM_DEFAULT);
    return;
  }
  if (command.op === 'set') {
    applyMainZoomFactor(command.factor);
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
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });
  if (LOCAL_NETWORK_COMPAT_MODE) {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (request && isLocalNetworkHost(request.hostname)) {
        callback(0);
        return;
      }
      callback(-3);
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (!isLocalNetworkUrl(details.url)) {
        callback({});
        return;
      }
      const headers = { ...(details.responseHeaders || {}) };
      headers['Access-Control-Allow-Origin'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      headers['Access-Control-Allow-Credentials'] = ['true'];
      headers['Access-Control-Allow-Private-Network'] = ['true'];
      callback({ responseHeaders: headers });
    });
  }
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
  const protocolCommand = parseProtocolCommand(rawProtocolUrl);
  if (protocolCommand) {
    handleMainZoomCommand(protocolCommand);
    return;
  }

  const nextUrl = parseProtocolTarget(rawProtocolUrl);
  if (!isHttpUrl(nextUrl)) return;
  pendingProtocolTargetUrl = nextUrl;

  if (app.isReady()) {
    openCustomerDisplayWindow(nextUrl);
    focusMainWindow();
  }
}

function injectMainZoomControls(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`
    (() => {
      const ROOT_ID = 'menubuDesktopZoomTools';
      if (document.getElementById(ROOT_ID)) return;

      const STORAGE_KEY = ${JSON.stringify(MAIN_ZOOM_STORAGE_KEY)};
      const MIN = ${MAIN_ZOOM_MIN};
      const MAX = ${MAIN_ZOOM_MAX};
      const STEP = ${MAIN_ZOOM_STEP};
      const DEFAULT_ZOOM = ${mainZoomFactor};
      const COMMAND_BASE = '${PROTOCOL_NAME}://control';

      const clamp = (value) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return DEFAULT_ZOOM;
        return Math.max(MIN, Math.min(MAX, n));
      };
      const safeReadZoom = () => {
        try {
          return clamp(localStorage.getItem(STORAGE_KEY));
        } catch (_) {
          return DEFAULT_ZOOM;
        }
      };
      const safeWriteZoom = (value) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch (_) {
          // no-op
        }
      };
      const sendProtocolCommand = (action, extra = '') => {
        const url = COMMAND_BASE + '?action=' + encodeURIComponent(action) + (extra || '');
        try {
          window.open(url, '_blank', 'noopener');
        } catch (_) {
          try {
            window.location.assign(url);
          } catch (_) {
            // no-op
          }
        }
      };

      const root = document.createElement('div');
      root.id = ROOT_ID;
      root.style.position = 'fixed';
      root.style.right = '12px';
      root.style.bottom = '12px';
      root.style.zIndex = '2147483647';
      root.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      root.style.display = 'flex';
      root.style.flexDirection = 'column';
      root.style.alignItems = 'flex-end';
      root.style.gap = '8px';

      const makeBtn = (label, title, options = {}) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.title = title;
        btn.style.border = 'none';
        btn.style.borderRadius = options.round ? '999px' : '10px';
        btn.style.padding = options.compact ? '0' : '8px 12px';
        btn.style.fontWeight = '700';
        btn.style.cursor = 'pointer';
        btn.style.background = options.dark ? 'rgba(15,23,42,0.95)' : '#1f2937';
        btn.style.color = '#f8fafc';
        btn.style.width = options.square ? '40px' : 'auto';
        btn.style.height = options.square ? '40px' : 'auto';
        btn.style.fontSize = options.square ? '16px' : '14px';
        btn.style.display = 'inline-flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.boxShadow = '0 8px 20px rgba(2,6,23,0.35)';
        return btn;
      };

      const toggleBtn = makeBtn('', 'Yakınlaştır', { round: true, square: true, compact: true, dark: true });
      toggleBtn.setAttribute('aria-label', 'Yakınlaştır');
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#f8fafc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>';

      const panel = document.createElement('div');
      panel.style.display = 'none';
      panel.style.alignItems = 'center';
      panel.style.gap = '8px';
      panel.style.padding = '8px 10px';
      panel.style.borderRadius = '14px';
      panel.style.background = 'rgba(15,23,42,0.95)';
      panel.style.boxShadow = '0 14px 28px rgba(2,6,23,0.45)';

      const zoomOutBtn = makeBtn('-', 'Uzaklaştır', { round: true, square: true, compact: true, dark: true });
      const zoomInBtn = makeBtn('+', 'Yakınlaştır', { round: true, square: true, compact: true, dark: true });
      const resetBtn = makeBtn('100%', 'Yakınlaştırmayı sıfırla', { dark: true });
      resetBtn.style.minWidth = '62px';

      const zoomText = document.createElement('span');
      zoomText.style.minWidth = '56px';
      zoomText.style.textAlign = 'center';
      zoomText.style.color = '#f8fafc';
      zoomText.style.fontSize = '13px';
      zoomText.style.fontWeight = '700';

      let currentZoom = safeReadZoom();
      const renderZoom = () => {
        zoomText.textContent = Math.round(currentZoom * 100) + '%';
      };
      renderZoom();

      const setZoom = (nextValue) => {
        currentZoom = clamp(nextValue);
        safeWriteZoom(currentZoom);
        renderZoom();
        sendProtocolCommand('zoom-set', '&factor=' + encodeURIComponent(String(currentZoom)));
      };

      zoomOutBtn.addEventListener('click', () => {
        setZoom(currentZoom - STEP);
      });
      resetBtn.addEventListener('click', () => {
        setZoom(1);
      });
      zoomInBtn.addEventListener('click', () => {
        setZoom(currentZoom + STEP);
      });

      toggleBtn.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      });

      panel.appendChild(zoomOutBtn);
      panel.appendChild(zoomText);
      panel.appendChild(zoomInBtn);
      panel.appendChild(resetBtn);
      root.appendChild(panel);
      root.appendChild(toggleBtn);
      document.body.appendChild(root);
    })();
  `).catch(() => {
    // no-op
  });
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
      sandbox: true,
      allowRunningInsecureContent: LOCAL_NETWORK_COMPAT_MODE,
      webSecurity: !LOCAL_NETWORK_COMPAT_MODE
    }
  });
  applyMainZoomFactor(mainZoomFactor);

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

  mainWindow.webContents.on('did-finish-load', () => {
    applyMainZoomFactor(mainZoomFactor);
    injectMainZoomControls(mainWindow);
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
setupLocalNetworkCompatibility();

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
      focusMainWindow();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}
