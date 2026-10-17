'use strict';
/**
 * Electron main process.
 *
 * The benchmark engine lives here rather than in the window: it needs raw UDP
 * sockets, TLS and HTTPS agents, which the renderer must never have. The window
 * talks to it over a narrow, explicitly listed IPC surface (see preload.js).
 *
 * Headless mode: `ResolverBench.app/Contents/MacOS/ResolverBench --headless …`
 * re-enters this same file as Node (ELECTRON_RUN_AS_NODE) and hands the rest of
 * the command line to the engine's CLI, so a scheduled run and an interactive
 * run are the same code path.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { runBenchmark } = require('../engine/bench');
const corpusTools = require('../engine/corpus');
const resolverCatalog = require('../engine/resolvers');
const systemTools = require('../engine/system');
const conclusions = require('../engine/conclusions');
const csvTools = require('../engine/csv');

const CLI_PATH = path.join(__dirname, '..', 'engine', 'cli.js');
const PROJECT_URL = 'https://github.com/jakepi-bot/resolverbench';

/** Sample plans. Fifty lookups per resolver is the default, as in GRC's tool. */
const MODES = {
  quick: { cached: 8, uncached: 6, dotcom: 6 },
  standard: { cached: 20, uncached: 15, dotcom: 15 },
  thorough: { cached: 40, uncached: 30, dotcom: 30 },
};

const VALID_TRANSPORTS = new Set(['udp', 'tcp', 'dot', 'doh']);

let mainWindow = null;
let currentRun = null;

// --------------------------------------------------------------- headless ---

function headlessArgs() {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  const index = argv.indexOf('--headless');
  if (index === -1) return null;
  return argv.slice(index + 1);
}

const headless = headlessArgs();
if (headless) {
  const child = spawn(process.execPath, [CLI_PATH, ...headless], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code, signal) => {
    if (signal) app.exit(4);
    else app.exit(code === null ? 1 : code);
  });
}

// ------------------------------------------------------------------ window ---

function createWindow() {
  // `--theme=dark|light` pins the appearance, which is what the screenshot
  // capture uses so the shipped screenshots do not depend on the host's theme.
  const themeFlag = process.argv.find((a) => a.startsWith('--theme='));
  if (themeFlag) {
    const value = themeFlag.slice('--theme='.length);
    if (value === 'dark' || value === 'light') nativeTheme.themeSource = value;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    title: 'ResolverBench',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f4f5f7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // `--selftest-ui [ids]` drives one real run through the window's own IPC
  // path and prints what it rendered, so a build machine can prove the app
  // works rather than merely that it launched.
  const selftestIndex = process.argv.indexOf('--selftest-ui');
  if (selftestIndex !== -1) {
    const ids = (process.argv[selftestIndex + 1] || '').startsWith('--') ? '' : process.argv[selftestIndex + 1];
    const shotFlag = process.argv.find((a) => a.startsWith('--screenshot='));
    const shotDir = shotFlag ? shotFlag.slice('--screenshot='.length) : null;
    const consoleMessages = [];

    mainWindow.webContents.on('console-message', function onConsoleMessage(event) {
      // Electron 44 passes an object; older releases passed positional
      // arguments (declared with one parameter so Electron does not warn about
      // the deprecated signature).
      if (event && typeof event === 'object' && 'message' in event) {
        consoleMessages.push({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber });
      } else {
        consoleMessages.push({ level: arguments[1], message: arguments[2] });
      }
    });

    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // Give the renderer a moment to finish loading the catalog.
        await new Promise((resolve) => setTimeout(resolve, 800));
        const report = await mainWindow.webContents.executeJavaScript(
          `window.__selftest(${JSON.stringify(ids || '')})`,
        );

        if (shotDir) {
          fs.mkdirSync(shotDir, { recursive: true });
          for (const tab of ['chart', 'table', 'conclusions', 'log']) {
            // eslint-disable-next-line no-await-in-loop
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('.tab[data-tab="${tab}"]').click()`,
            );
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 350));
            // eslint-disable-next-line no-await-in-loop
            const image = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, `${tab}.png`), image.toPNG());
          }
          report.screenshots = fs.readdirSync(shotDir);
        }

        const errors = consoleMessages.filter((m) => m.level === 'error' || m.level === 3);
        report.console = { total: consoleMessages.length, errors };
        process.stdout.write(`SELFTEST ${JSON.stringify(report, null, 2)}\n`);
        const ok = report && report.ok && report.canvas?.drewSomething && report.tableRows > 0 && errors.length === 0;
        app.exit(ok ? 0 : 1);
      } catch (err) {
        process.stderr.write(`SELFTEST failed: ${err && err.message ? err.message : err}\n`);
        app.exit(1);
      }
    });
  }

  // Links open in the user's browser, never in the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Benchmark',
      submenu: [
        {
          label: 'Run Benchmark',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendToWindow('menu', { action: 'run' }),
        },
        {
          label: 'Stop',
          accelerator: 'CmdOrCtrl+.',
          click: () => sendToWindow('menu', { action: 'stop' }),
        },
        { type: 'separator' },
        {
          label: 'Export Results as CSV…',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToWindow('menu', { action: 'export-csv' }),
        },
        { label: 'Save Full Report…', click: () => sendToWindow('menu', { action: 'export-report' }) },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Response Time Bar Chart',
          accelerator: 'CmdOrCtrl+1',
          click: () => sendToWindow('menu', { action: 'tab', tab: 'chart' }),
        },
        {
          label: 'Tabular Data',
          accelerator: 'CmdOrCtrl+2',
          click: () => sendToWindow('menu', { action: 'tab', tab: 'table' }),
        },
        {
          label: 'Conclusions',
          accelerator: 'CmdOrCtrl+3',
          click: () => sendToWindow('menu', { action: 'tab', tab: 'conclusions' }),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Project Home', click: () => shell.openExternal(PROJECT_URL) },
        {
          label: 'How the benchmark works',
          click: () => shell.openExternal(`${PROJECT_URL}#how-the-benchmark-works`),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------------- IPC ---

function sanitizeServer(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid resolver entry');
  const transport = String(input.transport || '').toLowerCase();
  if (!VALID_TRANSPORTS.has(transport)) throw new Error(`unsupported transport: ${input.transport}`);
  const host = String(input.host || '').trim();
  if (!host) throw new Error('resolver entry has no host');
  let url = null;
  if (transport === 'doh') {
    url = String(input.url || '').trim();
    if (!/^https:\/\//i.test(url)) throw new Error(`a DoH endpoint must be an https URL`);
  }
  const port = Number(input.port) || (transport === 'doh' ? 443 : transport === 'dot' ? 853 : 53);
  return {
    id: String(input.id || `${transport}-${host}`),
    label: String(input.label || host).slice(0, 120),
    operator: input.operator ? String(input.operator).slice(0, 120) : null,
    transport,
    host,
    ip: input.ip ? String(input.ip) : null,
    port,
    url,
    sni: input.sni ? String(input.sni) : null,
    isSystem: !!input.isSystem,
    isCustom: !!input.isCustom,
  };
}

ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  projectUrl: PROJECT_URL,
  modes: MODES,
}));

ipcMain.handle('catalog:list', () => ({
  catalog: resolverCatalog.CATALOG.map((entry) => resolverCatalog.materialize(entry)),
  defaults: resolverCatalog.DEFAULT_IDS,
}));

ipcMain.handle('system:resolvers', () => systemTools.detectSystemResolvers());

ipcMain.handle('resolvers:parse', (event, text) => {
  try {
    if (/\r?\n/.test(text)) return { ok: true, ...resolverCatalog.parseCustomList(text) };
    const entry = resolverCatalog.parseCustomEndpoint(text);
    return { ok: true, servers: entry ? [entry] : [], rejected: [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bench:start', async (event, config = {}) => {
  if (currentRun) return { ok: false, error: 'a benchmark is already running' };

  const mode = MODES[config.mode] ? config.mode : 'standard';
  const plan = corpusTools.buildPlan({
    ...MODES[mode],
    cachedSamples: config.samples?.cached ?? MODES[mode].cached,
    uncachedSamples: config.samples?.uncached ?? MODES[mode].uncached,
    dotcomSamples: config.samples?.dotcom ?? MODES[mode].dotcom,
  });

  let servers;
  try {
    servers = (config.servers || []).map(sanitizeServer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (servers.length === 0) return { ok: false, error: 'select at least one resolver' };

  const controller = new AbortController();
  currentRun = { controller, startedAt: Date.now() };

  try {
    const results = await runBenchmark({
      servers,
      plan,
      timeoutMs: Number(config.timeoutMs) || 1200,
      dnssec: !!config.dnssec,
      rebinding: config.rebinding !== false,
      hijack: config.hijack !== false,
      signal: controller.signal,
      onEvent: (event_) => sendToWindow('bench:event', event_),
    });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    currentRun = null;
  }
});

ipcMain.handle('bench:stop', () => {
  if (!currentRun) return { ok: false, error: 'nothing is running' };
  currentRun.controller.abort();
  return { ok: true };
});

ipcMain.handle('bench:running', () => !!currentRun);

ipcMain.handle('results:conclusions', (event, results) => {
  if (!results || !results.servers) return [];
  return conclusions.findingsFor(results);
});

async function saveWithDialog({ defaultName, filters, content }) {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, content);
  return { ok: true, path: filePath };
}

ipcMain.handle('export:csv', async (event, { results, options }) => {
  if (!results) return { ok: false, error: 'no results to export' };
  const text = csvTools.toCSV(results, {
    delimiter: options?.delimiter || ',',
    decimalComma: !!options?.decimalComma,
    recommended: conclusions.rankBy(results.servers, 'cached').slice(0, 3).map((s) => s.label),
  });
  return saveWithDialog({
    defaultName: `resolverbench-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    content: text,
  });
});

ipcMain.handle('export:json', async (event, { results }) => {
  if (!results) return { ok: false, error: 'no results to export' };
  return saveWithDialog({
    defaultName: `resolverbench-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
    content: `${JSON.stringify(results, null, 2)}\n`,
  });
});

ipcMain.handle('export:report', async (event, { results }) => {
  if (!results) return { ok: false, error: 'no results to export' };
  const findings = conclusions.findingsFor(results);
  const header = [
    `ResolverBench report — ${new Date(results.finishedAt || Date.now()).toISOString()}`,
    `${results.servers.length} resolvers, corpus of ${results.meta.corpusSize} domains, ` +
      `${results.meta.samplesPerResolver.cached}/${results.meta.samplesPerResolver.uncached}/${results.meta.samplesPerResolver.dotcom} ` +
      `cached/uncached/dot-com samples, ${(results.durationMs / 1000).toFixed(1)}s`,
    '',
    'Ranking (cached median, ms):',
    ...conclusions
      .rankBy(results.servers, 'cached')
      .map((s, i) => `  ${String(i + 1).padStart(2)}. ${s.label} (${s.endpoint}) ${s.cached.median} ms, reliability ${s.reliability.percent}%`),
    '',
    'Conclusions:',
    ...findings.map((f) => `[${f.severity.toUpperCase()}] ${f.text}`),
    '',
  ].join('\n');
  return saveWithDialog({
    defaultName: `resolverbench-report-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
    content: `${header}\n${csvTools.toCSV(results)}\n`,
  });
});

ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(String(text ?? ''));
  return { ok: true };
});

ipcMain.handle('shell:open', (event, url) => {
  if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url));
  return { ok: true };
});

// ------------------------------------------------------------------ start ---

if (!headless) {
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
