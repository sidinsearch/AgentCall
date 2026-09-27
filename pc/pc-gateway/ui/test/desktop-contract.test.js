import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  buildApplicationMenu,
  createWindowStateStore,
  isApplicationEntrypoint,
  registerApplicationLifecycle,
  registerIpcHandlers,
  superviseGatewayEvents,
} from '../electron/main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('workspace clicks cannot bubble into route navigation and discard user input', () => {
  const source = read('renderer/app.js');
  assert.equal(source.includes("querySelectorAll('[data-route]')"), false);
  assert.match(source, /querySelectorAll\('\.nav-button\[data-route\]'\)/);
});

const REQUIRED_MENU_ITEMS = [
  ['Calls', 'CommandOrControl+1'],
  ['Contacts', 'CommandOrControl+2'],
  ['Live Call', 'CommandOrControl+3'],
  ['MCP', 'CommandOrControl+4'],
  ['Android', 'CommandOrControl+5'],
  ['Speech', 'CommandOrControl+6'],
  ['Recordings', 'CommandOrControl+7'],
  ['Policy', 'CommandOrControl+8'],
  ['Settings', 'CommandOrControl+,'],
];

function flattenMenu(items) {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flattenMenu(item.submenu) : [])]);
}

test('packaged Electron application entrypoint starts even when argv has no source path', () => {
  const modulePath = '/opt/AgentCall Desktop/resources/app.asar/electron/main.js';
  const electronRuntime = { versions: { electron: '37.2.6' } };
  const nodeRuntime = { versions: { node: process.versions.node } };

  assert.equal(isApplicationEntrypoint(['/opt/AgentCall Desktop/agentcall-desktop'], modulePath, electronRuntime), true);
  assert.equal(isApplicationEntrypoint(['/usr/bin/node', modulePath], modulePath, nodeRuntime), true);
  assert.equal(isApplicationEntrypoint(['/usr/bin/node', '/tmp/importer.mjs'], modulePath, nodeRuntime), false);
});

test('native application menu exposes required destinations and shortcuts', () => {
  const messages = [];
  const items = flattenMenu(buildApplicationMenu((route) => messages.push(route)));

  for (const [label, accelerator] of REQUIRED_MENU_ITEMS) {
    const item = items.find((candidate) => candidate.label === label);
    assert.ok(item, `missing menu item ${label}`);
    assert.equal(item.accelerator, accelerator);
    item.click();
  }
  assert.deepEqual(messages, ['calls', 'contacts', 'live-call', 'mcp', 'android', 'speech', 'recordings', 'policy', 'settings']);
});

test('IPC handlers register declared channels once and authorize the canonical main frame', async () => {
  const registered = [];
  const handlers = new Map();
  const ipcMain = {
    removeHandler: (channel) => registered.push(`remove:${channel}`),
    handle: (channel, handler) => {
      assert.equal(typeof handler, 'function');
      registered.push(`handle:${channel}`);
      handlers.set(channel, handler);
    },
  };
  const rendererUrl = 'file:///opt/agentcall/resources/app.asar/renderer/index.html';

  registerIpcHandlers(ipcMain, { rendererUrl });
  assert.equal(registered.filter((entry) => entry.startsWith('handle:')).length, 13);
  assert.equal(registered.filter((entry) => entry.startsWith('remove:')).length, 13);

  const mainFrame = { url: rendererUrl };
  const sender = { mainFrame };
  await assert.doesNotReject(handlers.get('data:read')({ sender, senderFrame: mainFrame }, { resource: 'overview' }));
  for (const event of [
    null,
    { sender, senderFrame: { url: rendererUrl } },
    { sender: { mainFrame: { url: 'https://evil.example/' } }, senderFrame: { url: 'https://evil.example/' } },
  ]) {
    await assert.rejects(
      async () => handlers.get('data:read')(event, { resource: 'overview' }),
      /unauthorized ipc sender/i,
    );
  }
});

test('application lifecycle registers once, recreates one window on macOS, and quits elsewhere', () => {
  const listeners = new Map();
  const app = { on: (name, listener) => {
    assert.equal(listeners.has(name), false, `${name} registered twice`);
    listeners.set(name, listener);
  }, quitCalls: 0, quit() { this.quitCalls += 1; } };
  let windows = [];
  const BrowserWindow = { getAllWindows: () => windows };
  let created = 0;
  const createWindow = () => { created += 1; windows = [{}]; };

  registerApplicationLifecycle({ app, BrowserWindow, createWindow, platform: 'darwin' });
  listeners.get('activate')();
  assert.equal(created, 1);
  listeners.get('activate')();
  assert.equal(created, 1);
  windows = [];
  listeners.get('window-all-closed')();
  assert.equal(app.quitCalls, 0);
  listeners.get('activate')();
  assert.equal(created, 2);

  const linuxListeners = new Map();
  const linuxApp = { on: (name, listener) => linuxListeners.set(name, listener), quitCalls: 0, quit() { this.quitCalls += 1; } };
  registerApplicationLifecycle({ app: linuxApp, BrowserWindow, createWindow, platform: 'linux' });
  linuxListeners.get('window-all-closed')();
  assert.equal(linuxApp.quitCalls, 1);
});

test('window state store persists bounded JSON and recovers from invalid data', () => {
  let stored = '{"x":10,"y":10,"width":1100,"height":720}';
  const fakeFs = {
    readFileSync: () => stored,
    mkdirSync: () => {},
    writeFileSync: (_file, value) => { stored = value; },
  };
  const store = createWindowStateStore('/tmp/window-state.json', fakeFs);
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

  assert.deepEqual(store.load(workArea), { x: 10, y: 10, width: 1100, height: 720 });
  store.save({ x: 20, y: 30, width: 1200, height: 760 }, workArea);
  assert.deepEqual(JSON.parse(stored), { x: 20, y: 30, width: 1200, height: 760 });
  stored = '{invalid';
  assert.deepEqual(store.load(workArea), { x: 160, y: 90, width: 1280, height: 800 });
});

test('sandboxed packaged Electron uses a CommonJS preload bridge', () => {
  const main = read('electron/main.js');

  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(main, /preload\.js/);
});

test('production Electron uses local-only daemon IPC with no HTTP transport', () => {
  for (const relativePath of ['electron/main.js', 'electron/preload.cjs', 'renderer/app.js']) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /node:http|createServer\s*\(|\.listen\s*\(|\bfetch\s*\(/);
  }
  const main = read('electron/main.js');
  const client = read('electron/daemon-client.js');
  assert.match(main, /new DesktopDaemonClient/);
  assert.match(main, /startWindowsGateway/);
  assert.match(main, /registerIpcHandlers\(ipcMain, \{[\s\S]*gateway,[\s\S]*openPath:[\s\S]*writeClipboard:/);
  assert.match(client, /\/run\/agentcall\/gatewayd\.sock/);
  assert.doesNotMatch(read('package.json'), /node server\.js/);
});

test('renderer contains required routes, panes, and honest production states', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/app.js');
  const combined = `${html}\n${app}`;

  assert.match(html, /<div class="brand" aria-label="AgentCall"><img src="assets\/agentcall-icon\.png" alt=""><\/div>/);
  assert.match(app, /agentcall:\s*'assets\/agentcall-icon\.png'/);
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer/assets/agentcall-icon.png')));
  const css = read('renderer/styles.css');
  assert.match(css, /\.brand\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/);
  assert.match(css, /\.brand-mark\.agentcall\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/);

  for (const marker of [
    'nav-rail', 'call-list-pane', 'workspace-pane', 'inspector-pane', 'CONNECTING', 'SIMULATION MODE', 'UNAVAILABLE',
    'Calls', 'Live Call', 'MCP', 'Android', 'Speech', 'Recordings', 'Policy', 'Settings',
    'Disconnected', 'Authorizing', 'Unsupported device',
    'Call & privacy policy', 'Manual confirmation', 'No calls or recordings', 'integrity', 'retention',
  ]) assert.match(combined, new RegExp(marker, 'i'), `missing renderer marker ${marker}`);

  assert.match(html, /type="search"/);
  assert.match(html, /aria-label=/);
  assert.match(html, /media-src[^;]*agentcall-media:/);
  assert.doesNotMatch(html, /Returning caller|Unknown caller|checking my delivery|order reference|fixture-001/i);
});

test('Calls and Contacts use private mirrors while Recordings alone uses the finalized catalog', () => {
  const app = read('renderer/app.js');
  for (const marker of [
    'renderPhoneCallLog', 'renderContacts', "gatewayDesktop.read('callLog')", "gatewayDesktop.read('contacts')",
    'renderRecordings', "gatewayDesktop.read('storage')", 'recording.callId',
    'recording.durationMillis', 'recording.retention', 'playRecording', 'saveRecording', 'syncRecording', 'deleteRecording',
    "import { boundedFinalizedCatalog, canOpenFinalizedRecording } from '../lib/catalog.js'",
    'play.disabled = !canOpenFinalizedRecording(recording)',
    'if (!canOpenFinalizedRecording(recording)) return',
  ]) assert.ok(app.includes(marker), `missing phone-data/recording marker ${marker}`);
  assert.equal(app.match(/boundedFinalizedCatalog\(data\.recordings\)/g)?.length, 1);
  assert.ok((app.match(/gatewayDesktop\.read\('callLog'\)/g)?.length ?? 0) >= 1);
  assert.ok((app.match(/gatewayDesktop\.read\('contacts'\)/g)?.length ?? 0) >= 1);
  assert.doesNotMatch(app, /function boundedCatalogEntry\s*\(/);
  assert.match(app, /DOMContentLoaded[\s\S]*renderPhoneCallLog/);
});

test('Calls and Live routes restore real workspaces with qualification-gated controls and persistent feedback', () => {
  const app = read('renderer/app.js');
  const html = read('renderer/index.html');
  for (const marker of [
    'renderCalls', 'renderLiveCall', "gatewayDesktop.read('liveCall')", 'gatewayDesktop.call',
    'Qualified hardware required', 'Recording health required', 'role', 'alert',
    'recording-action-feedback', 'call-action-feedback', 'data-new-call', "selectRoute('live-call')",
  ]) assert.ok(`${app}\n${html}`.includes(marker), `missing Calls/Live marker ${marker}`);
  assert.doesNotMatch(app, /route === 'calls' \|\| route === 'live-call'\) return/);
  assert.match(app, /receipt\.accepted !== true \|\| receipt\.configured !== true/);
  assert.match(app, /qualification.*unsupported|unsupported.*qualification/i);
});

test('compact navigation exposes all destinations without horizontal clipping', () => {
  const html = read('renderer/index.html');
  const css = read('renderer/styles.css');
  assert.match(html, /aria-current=/);
  assert.doesNotMatch(css, /\.nav-rail[^{}]*overflow-x:\s*auto/);
  assert.match(css, /@media[^{}]*max-width:\s*640px[\s\S]*?\.nav-rail[\s\S]*?grid-template-columns:\s*repeat\(4/);
});

test('MCP and Android routes render live actionable setup without privileged mutation', () => {
  const app = read('renderer/app.js');
  const desktop = `${app}\n${read('electron/main.js')}\n${read('resources/windows/agentcall-mcp.cmd')}`;
  for (const marker of [
    'renderMcp', 'renderAndroid', '/usr/bin/agentcall-mcp',
    'hermes mcp add agentcall --command', 'hermes mcp test agentcall',
    'openclaw mcp add agentcall --command', 'openclaw mcp doctor agentcall --probe',
    'agentcall-mcp.cmd', 'ELECTRON_RUN_AS_NODE',
    'copyText', 'Authorizing', 'Authenticated USB', 'SIMULATOR',
  ]) assert.match(desktop, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(desktop, /sudo |systemctl start|adb install|hermes config set/);
});

test('gateway event supervision retries late startup and reconnects after stream closure', async () => {
  const gateway = new EventEmitter();
  const queued = [];
  let attempts = 0;
  let ready = 0;
  let stopped = 0;
  gateway.startEvents = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('gateway is still starting');
  };
  gateway.stopEvents = () => { stopped += 1; };
  const stop = superviseGatewayEvents(gateway, {
    retryDelayMs: 25,
    setTimer: (callback, delay) => {
      assert.equal(delay, 25);
      queued.push(callback);
      return { unref() {} };
    },
    clearTimer: () => {},
    onReady: () => { ready += 1; },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(queued.length, 1);
  queued.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(ready, 1);

  gateway.emit('eventsClosed');
  assert.equal(queued.length, 1);
  queued.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(ready, 2);

  stop();
  gateway.emit('eventsClosed');
  assert.equal(stopped, 1);
  assert.equal(queued.length, 0);
});

test('Speech route renders truthful active and pending provider lifecycle through write-only preload API', () => {
  const app = read('renderer/app.js');
  const css = read('renderer/styles.css');
  for (const marker of [
    'renderSpeech', 'speech-settings', "createSpeechCard('stt'", "createSpeechCard('tts'", 'kind.toUpperCase',
    'provider-picker', 'choice-select', "aria-current",
    'gpt-4o-transcribe', 'scribe_v2_realtime', 'supertonic-3', 'eleven_flash_v2_5',
    'eleven_multilingual_v2', 'eleven_v3', 'gpt-4o-mini-tts-2025-12-15',
    "label: 'OpenAI'", "label: 'ElevenLabs'", "label: 'Supertonic'",
    'gatewayDesktop.read', 'gatewayDesktop.saveSecret', 'gatewayDesktop.checkProviderHealth',
    'Active now', 'Pending restart', 'Complete STT and TTS setup', 'Check health',
    "result.scope === 'credential'", 'Credential available', 'Endpoint/model verified', 'Restart gatewayd before checking this saved provider',
    'gatewayDesktop.testProviders', 'Test active speech pair', 'Synthesizing, transcribing, and opening playback',
    'Expected phrase', 'Transcript', 'Playback opened',
  ]) assert.ok(app.includes(marker), `missing Speech setup marker ${marker}`);
  assert.match(css, /\.provider-option \.brand-mark\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/);
  for (const provider of ['openai', 'elevenlabs', 'supertonic']) {
    assert.match(css, new RegExp(`\\.provider-option \\.brand-mark\\.${provider}\\s*\\{[^}]*padding:\\s*[45]px;`));
  }
  assert.doesNotMatch(app, /label: 'ElevenLabs Flash'/);
  assert.doesNotMatch(app, /readyAfterRestart|Simulated write-only configuration/i);
});

test('Contacts, phone Call Log, New Call, and automatic pairing are first-class enabled surfaces', () => {
  const app = read('renderer/app.js');
  const html = read('renderer/index.html');
  const main = read('electron/main.js');
  for (const marker of [
    'data-route="contacts"', 'data-new-call', 'renderContacts', 'renderPhoneCallLog',
    "gatewayDesktop.read('contacts')", "gatewayDesktop.read('callLog')",
    'prepareOutboundCall', 'row-call-button', 'No call starts automatically',
    "selectRoute('live-call')", 'Connect desktop', 'USB debugging authorized',
    'usb_debugging_authorization_required', 'phone_app_not_ready', 'Approve USB debugging',
  ]) assert.ok(`${html}\n${app}\n${main}`.includes(marker), `missing enabled desktop marker ${marker}`);
  assert.doesNotMatch(`${html}\n${app}`, /New outbound calls are unavailable|Dial disabled by default|approve controller enrollment|enrollment is approved|enter.*controller secret/i);
  assert.doesNotMatch(html, /data-new-call[^>]*disabled|disabled[^>]*data-new-call/i);
});

test('renderer CSS uses shared tokens, 44px controls, and two-stage pane collapse', () => {
  const css = read('renderer/styles.css');
  const tokens = {
    'accent-600': '#087F8C',
    'accent-500': '#0EA5A8',
    'accent-100': '#DDF7F5',
    'ink-900': '#162126',
    'ink-600': '#52636B',
    'surface-0': '#FFFFFF',
    'surface-1': '#F6F8F9',
    'surface-2': '#E9EFF1',
    healthy: '#238636',
    degraded: '#B7791F',
    danger: '#D93025',
    info: '#2563EB',
  };
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(css, new RegExp(`--${name}:\\s*${value}`, 'i'), `missing token ${name}`);
  }
  assert.match(css, /min-(?:width|height):\s*44px/);
  assert.match(css, /\.warning-text\s*\{\s*color:\s*var\(--degraded\)/);
  assert.match(css, /@media[^{}]*max-width:\s*1180px[\s\S]*?\.inspector-pane[\s\S]*?display:\s*none/);
  assert.match(css, /@media[^{}]*max-width:\s*860px[\s\S]*?\.call-list-pane[\s\S]*?(?:display:\s*none|transform:)/);
  assert.match(css, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(css, /box-shadow:\s*(?:[1-9]\d{2,}|-[1-9]\d{2,})px/);
});

test('package starts Electron and configures the unified Linux desktop Debian base', () => {
  const pkg = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.doesNotMatch(`${pkg.description}\n${readme}`, /fixture backed|simulation.backed/i);
  assert.ok(!pkg.build.deb.depends.some((dependency) => dependency.includes('agentcall-gatewayd')));

  assert.equal(pkg.main, 'electron/main.js');
  assert.match(pkg.scripts.start, /^electron\s+\.$/);
  assert.ok(pkg.devDependencies?.electron);
  assert.ok(pkg.devDependencies?.['electron-builder']);
  assert.deepEqual(pkg.build.linux.target, ['deb']);
  assert.equal(pkg.build.linux.icon, 'build/icons');
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.ok(pkg.build.files.includes('renderer/**/*'));
  assert.ok(fs.existsSync(path.join(ROOT, 'build/icon.png')));
  for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
    assert.ok(fs.existsSync(path.join(ROOT, `build/icons/${size}x${size}.png`)));
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'build/icon.ico')));
  assert.ok(fs.existsSync(path.join(ROOT, 'README.md')));
  assert.ok(fs.existsSync(path.join(ROOT, '../../../packaging/linux/build-unified-desktop-deb.sh')));
  assert.ok(fs.existsSync(path.join(ROOT, '../../../packaging/linux/test-unified-desktop-package.sh')));
});
