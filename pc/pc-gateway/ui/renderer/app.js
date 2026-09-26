import { boundedFinalizedCatalog, canOpenFinalizedRecording } from '../lib/catalog.js';
import { incomingCallIdentity } from '../lib/phone.js';
import {
  frameManualPcm,
  MAX_MANUAL_AUDIO_QUEUED_FRAMES,
} from '../lib/audio.js';

const routeStates = Object.freeze({
  calls: 'Waiting for synchronized phone call log',
  contacts: 'Waiting for synchronized contacts',
  'live-call': 'Connect a qualified phone to use live call controls',
  mcp: 'Connect Hermes or OpenClaw through the local MCP bridge',
  android: 'Review the phone connection and setup checklist',
  speech: 'Choose speech-to-text and text-to-speech providers independently',
  recordings: 'Review finalized recordings and retention',
  policy: 'Review the protections applied to calls, recordings, and private data',
  settings: 'Review desktop service, synchronization, and storage status',
});

let manualAudio = null;
let liveCallRefreshTimer = null;
let liveCallPresentation = null;
let liveCallClock = null;
let liveCallSnapshotKey = '';
let incomingRinger = null;

function scheduleLiveCallRefresh(delay = 750) {
  window.clearTimeout(liveCallRefreshTimer);
  if (document.querySelector('.app-shell')?.dataset.route !== 'live-call') return;
  liveCallRefreshTimer = window.setTimeout(() => { void refreshLiveCall(); }, delay);
}

function liveCallElapsed(startedAt) {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  return `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}

function liveCallKey(data) {
  const status = data?.status ?? {};
  const call = status.currentCall ?? null;
  return JSON.stringify({
    identity: status.identity,
    simulator: status.simulator,
    connected: status.device?.connected,
    authenticated: status.device?.authenticated,
    phase: status.device?.phase,
    recording: status.recording?.healthy,
    call: call ? {
      callId: call.callId,
      phase: call.phase,
      state: call.state,
      direction: call.direction,
      displayNumber: call.displayNumber,
      contactName: call.contactName,
      mediaState: call.mediaState,
    } : null,
  });
}

function stopIncomingRinger() {
  if (!incomingRinger) return;
  window.clearInterval(incomingRinger.timer);
  void incomingRinger.context.close().catch(() => {});
  incomingRinger = null;
}

function startIncomingRinger(callId) {
  if (!callId || incomingRinger?.callId === callId) return;
  stopIncomingRinger();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const pulse = () => {
    void context.resume().catch(() => {});
    for (const offset of [0, 0.42]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, context.currentTime + offset);
      oscillator.frequency.linearRampToValueAtTime(520, context.currentTime + offset + 0.28);
      gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.34);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.35);
    }
  };
  pulse();
  incomingRinger = { callId, context, timer: window.setInterval(pulse, 2_400) };
}

function syncIncomingRinger(call) {
  const state = String(call?.state ?? call?.phase ?? '').toLowerCase();
  const ringing = call?.direction === 'incoming' && ['incoming', 'ringing'].includes(state);
  if (ringing) startIncomingRinger(call.callId); else stopIncomingRinger();
}

async function refreshLiveCall() {
  if (document.querySelector('.app-shell')?.dataset.route !== 'live-call') return;
  try {
    const data = await window.gatewayDesktop.read('liveCall');
    const nextKey = liveCallKey(data);
    if (nextKey !== liveCallSnapshotKey) {
      await renderLiveCall(data);
      return;
    }
    const call = data?.status?.currentCall;
    syncIncomingRinger(call);
    const elapsed = document.querySelector('.live-call-elapsed strong');
    if (elapsed && call) {
      elapsed.textContent = liveCallElapsed(liveCallClock?.startedAt ?? Date.now());
    }
    if (call) scheduleLiveCallRefresh();
  } catch {
    stopIncomingRinger();
    await renderLiveCall();
  }
}

function pcm16FromFloat32(input, inputRate, outputRate = 16_000) {
  const outputLength = Math.max(1, Math.floor(input.length * outputRate / inputRate));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let total = 0;
    for (let sample = start; sample < end; sample++) total += input[sample];
    const value = Math.max(-1, Math.min(1, total / (end - start)));
    output[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return output;
}

async function startManualAudio(callId) {
  if (manualAudio?.callId === callId) return;
  await stopManualAudio();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  try {
    await window.gatewayDesktop.startManualAudio(callId);
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const capture = context.createScriptProcessor(4096, 1, 1);
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(capture); capture.connect(silence); silence.connect(context.destination);
    const session = {
      callId,
      stream,
      context,
      source,
      capture,
      silence,
      nextPlaybackTime: 0,
      pcmRemainder: new Uint8Array(),
      queuedFrames: 0,
      sendChain: Promise.resolve(),
    };
    capture.onaudioprocess = (event) => {
      if (manualAudio !== session) return;
      const pcm = pcm16FromFloat32(event.inputBuffer.getChannelData(0), context.sampleRate);
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const framed = frameManualPcm(session.pcmRemainder, bytes);
      session.pcmRemainder = framed.remainder;
      if (session.queuedFrames + framed.frames.length > MAX_MANUAL_AUDIO_QUEUED_FRAMES) {
        void stopManualAudio();
        return;
      }
      session.queuedFrames += framed.frames.length;
      session.sendChain = session.sendChain.then(async () => {
        for (const frame of framed.frames) {
          if (manualAudio !== session) return;
          await window.gatewayDesktop.pushManualAudio(callId, frame);
        }
      }).catch(() => stopManualAudio()).finally(() => {
        session.queuedFrames -= framed.frames.length;
      });
    };
    manualAudio = session;
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    try { await window.gatewayDesktop.stopManualAudio(callId); } catch {}
    throw error;
  }
}

async function stopManualAudio() {
  const session = manualAudio;
  if (!session) return;
  manualAudio = null;
  session.capture.onaudioprocess = null;
  try { session.source.disconnect(); session.capture.disconnect(); session.silence.disconnect(); } catch {}
  for (const track of session.stream.getTracks()) track.stop();
  try { await session.context.close(); } catch {}
  try { await window.gatewayDesktop.stopManualAudio(session.callId); } catch {}
}

function playManualAudio(frame) {
  const session = manualAudio;
  if (!session || frame.callId !== session.callId) return;
  const bytes = frame.pcm instanceof Uint8Array ? frame.pcm : new Uint8Array(frame.pcm);
  if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) return;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const buffer = session.context.createBuffer(1, samples.length, 16_000);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) channel[index] = samples[index] / 0x8000;
  const source = session.context.createBufferSource();
  source.buffer = buffer;
  source.connect(session.context.destination);
  const startAt = Math.max(session.context.currentTime + 0.015, session.nextPlaybackTime);
  source.start(startAt);
  session.nextPlaybackTime = startAt + buffer.duration;
}

async function refreshRuntimeStatus() {
  const banner = document.querySelector('#runtime-banner');
  const inspectorState = document.querySelector('#inspector-android-state');
  const inspectorDetail = document.querySelector('#inspector-android-detail');
  try {
    const overview = await window.gatewayDesktop?.read('overview');
    const mode = overview?.mode ?? 'unavailable';
    const gateway = mode === 'live' ? overview.gateway ?? {} : {};
    const device = gateway.device ?? {};
    document.documentElement.dataset.mode = mode;
    if (banner) {
      banner.textContent = mode === 'live'
        ? 'LIVE · connected to local gatewayd'
        : mode === 'fixture'
          ? 'SIMULATION MODE · live gateway data unavailable'
          : 'UNAVAILABLE · local gatewayd is not connected';
    }
    if (inspectorState && inspectorDetail) {
      const [connection, guidance, tone] = androidGuidance(device, gateway);
      inspectorState.textContent = connection;
      inspectorState.className = tone;
      inspectorDetail.textContent = device.authenticated && gateway.recording?.healthy
        ? 'Secure USB active · recording healthy'
        : guidance;
    }
    return overview;
  } catch {
    document.documentElement.dataset.mode = 'unavailable';
    if (banner) banner.textContent = 'UNAVAILABLE · local gatewayd is not connected';
    if (inspectorState) { inspectorState.textContent = 'Disconnected'; inspectorState.className = 'danger-text'; }
    if (inspectorDetail) inspectorDetail.textContent = 'Connect the phone and tap Connect desktop';
    return null;
  }
}

async function selectRoute(route) {
  document.querySelector('.app-shell').dataset.route = route;
  document.querySelectorAll('.nav-button[data-route]').forEach((button) => {
    const selected = button.dataset.route === route;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (route === 'calls') return renderCalls();
  if (route === 'contacts') return renderContacts();
  if (route === 'live-call') return renderLiveCall();
  if (route === 'recordings') {
    await renderRecordings();
    return;
  }
  if (route === 'speech') {
    await renderSpeech();
    return;
  }
  if (route === 'mcp') {
    await renderMcp();
    return;
  }
  if (route === 'android') {
    await renderAndroid();
    return;
  }
  if (route === 'policy') {
    await renderPolicy();
    return;
  }
  if (route === 'settings') {
    await renderSettings();
    return;
  }
  const workspace = document.querySelector('.workspace-pane');
  const template = document.querySelector('#panel-template');
  const panel = template.content.cloneNode(true);
  panel.querySelector('h2').textContent = ({ mcp: 'MCP', android: 'Android', speech: 'Speech', policy: 'Policy', settings: 'Settings' })[route] ?? 'Calls';
  panel.querySelector('.panel-state').textContent = routeStates[route] ?? 'Disconnected';
  workspace.replaceChildren(panel);
}

const MCP_COMMANDS = Object.freeze({
  hermes: Object.freeze({
    test: 'hermes mcp test agentcall',
    list: 'hermes mcp list',
  }),
  openclaw: Object.freeze({
    test: 'openclaw mcp doctor agentcall --probe',
    list: 'openclaw mcp status --verbose',
  }),
});

function setupPanel(title, stateText) {
  const panel = document.createElement('section');
  panel.className = 'route-panel setup-panel';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const state = document.createElement('p');
  state.className = 'panel-state';
  state.textContent = stateText;
  panel.append(heading, state);
  return panel;
}

function brandMark(name) {
  const mark = document.createElement('span');
  mark.className = `brand-mark ${name}`;
  const officialAsset = {
    openai: 'assets/openai-light.svg',
    elevenlabs: 'assets/elevenlabs.png',
    hermes: 'assets/hermes-agent.png',
    openclaw: 'assets/openclaw.svg',
    supertonic: 'assets/supertonic-symbol.svg',
    agentcall: 'assets/agentcall-icon.png',
  }[name];
  if (officialAsset) {
    const image = document.createElement('img');
    image.src = officialAsset;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    mark.append(image);
    return mark;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#brand-${name}`);
  svg.append(use);
  mark.append(svg);
  return mark;
}

function setupCard(title, description, brand = '') {
  const card = document.createElement('section');
  card.className = 'setup-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  if (brand) {
    const branded = document.createElement('div');
    branded.className = 'brand-heading';
    branded.append(brandMark(brand), heading);
    card.append(branded);
  } else card.append(heading);
  const copy = document.createElement('p');
  copy.className = 'muted';
  copy.textContent = description;
  card.append(copy);
  return card;
}

function addStatusRow(card, label, value, tone = '') {
  const row = document.createElement('div');
  row.className = 'setup-status-row';
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('strong');
  content.textContent = value;
  if (tone) content.className = tone;
  row.append(key, content);
  card.append(row);
}

function commandRow(label, command) {
  const row = document.createElement('div');
  row.className = 'command-row';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = label;
  const code = document.createElement('code');
  code.textContent = command;
  copy.append(title, code);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Copy';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await window.gatewayDesktop.copyText(command);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    } finally {
      window.setTimeout(() => { button.disabled = false; button.textContent = 'Copy'; }, 1600);
    }
  });
  row.append(copy, button);
  return row;
}

async function renderMcp() {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Agent integrations', 'Checking the local gateway and MCP launcher…');
  workspace.replaceChildren(panel);
  let integration = null;
  try {
    const data = await window.gatewayDesktop.read('mcp');
    integration = data?.integration ?? null;
    if (data?.mode !== 'live') throw new Error('gateway unavailable');
    const tools = Array.isArray(data.capabilities?.tools)
      ? data.capabilities.tools.filter((tool) => typeof tool === 'string').slice(0, 32)
      : [];
    panel.querySelector('.panel-state').textContent = `${integration?.os ?? 'Local'} stdio MCP · no network endpoint or device credential required`;
    const status = setupCard('Secure local MCP', 'Hermes or OpenClaw launches the packaged stdio bridge. The bridge reaches gatewayd through a local, access-controlled IPC channel.');
    addStatusRow(status, 'Operating system', integration?.os ?? 'Unknown');
    addStatusRow(status, 'Launcher', integration?.launcher ?? 'Unavailable', integration?.launcher ? 'healthy-text' : 'warning-text');
    addStatusRow(status, 'Gateway daemon', data.status?.state === 'running' ? 'Running' : String(data.status?.state ?? 'Unavailable'), data.status?.state === 'running' ? 'healthy-text' : 'danger-text');
    addStatusRow(status, 'Semantic tools', `${tools.length} discovered`, tools.length > 0 ? 'healthy-text' : 'danger-text');
    const toolCopy = document.createElement('p');
    toolCopy.className = 'tool-list';
    toolCopy.textContent = tools.join(' · ') || 'Tool list unavailable';
    status.append(toolCopy);
    const hermesPlatform = integration.os === 'Windows' ? 'Windows' : integration.os === 'Linux' ? 'Linux' : 'local';
    const hermes = setupCard('Hermes', `Register the ${hermesPlatform} launcher as your normal desktop user. AgentCall never edits your agent profile automatically.`, 'hermes');
    hermes.append(
      commandRow('1. Register AgentCall', integration.hermesAdd),
      commandRow('2. Verify connectivity', MCP_COMMANDS.hermes.test),
      commandRow('3. Review configured servers', MCP_COMMANDS.hermes.list),
    );
    const openclaw = setupCard('OpenClaw', 'Add the same local stdio server, then run OpenClaw’s built-in static and live connection checks.', 'openclaw');
    openclaw.append(
      commandRow('1. Register AgentCall', integration.openclawAdd),
      commandRow('2. Diagnose and probe', MCP_COMMANDS.openclaw.test),
      commandRow('3. Review MCP status', MCP_COMMANDS.openclaw.list),
    );
    const safety = setupCard('Local control boundary', 'MCP exposes only the documented call tools. USB access and device authentication remain owned by the local gateway service.');
    panel.append(status, hermes, openclaw, safety);
  } catch {
    panel.querySelector('.panel-state').textContent = 'UNAVAILABLE · the local gateway must be reachable before Hermes or OpenClaw can use AgentCall';
    const commands = setupCard(`${integration?.os ?? 'Local'} MCP launcher`, 'Start the desktop gateway, then register the launcher shown for this operating system.');
    if (integration?.hermesAdd && integration?.openclawAdd) commands.append(
      commandRow('Register with Hermes', integration.hermesAdd),
      commandRow('Register with OpenClaw', integration.openclawAdd),
    ); else addStatusRow(commands, 'Launcher', 'Unavailable until the desktop app is restarted', 'warning-text');
    panel.append(commands);
  }
}

function androidGuidance(device, gateway) {
  if (device?.transport === 'simulator') return ['SIMULATOR', 'Software transport is connected; this is not phone hardware qualification.', 'info-text'];
  if (device?.connected && device?.authenticated && device?.phase === 'ready') return ['Authenticated USB', 'Phone and gatewayd completed mutual authentication over the USB-only transport.', 'healthy-text'];
  const setup = gateway?.setup ?? {};
  const reason = {
    usb_debugging_authorization_required: ['Approve USB debugging', 'Unlock the phone and approve the USB debugging prompt for this desktop.', 'info-text'],
    phone_app_not_ready: ['Ready to pair', 'Open AgentCall on the phone and tap Connect desktop. If this phone is paired to another desktop profile, disconnect it and choose Forget paired desktop first.', 'info-text'],
    multiple_phones_connected: ['Choose one phone', 'Disconnect other Android devices, leaving only the supported phone attached.', 'danger-text'],
    phone_offline: ['Phone offline', 'Unlock and reconnect the phone, then confirm USB debugging remains enabled.', 'danger-text'],
    usb_access_denied: ['USB access blocked', 'Reconnect the phone after installing the desktop package USB rules.', 'danger-text'],
    unsupported_phone_build: ['Unsupported phone build', 'The attached phone does not match this release. Install the matching Android and device-module artifacts.', 'danger-text'],
    secure_pairing_failed: ['Pairing interrupted', 'Keep the cable connected and tap Connect desktop again on the phone.', 'danger-text'],
  }[setup.reasonCode];
  if (reason) return reason;
  if (setup.stage === 'VERIFYING_DEVICE') return ['Checking phone', 'Verifying the supported device and matched Android release.', 'info-text'];
  if (setup.stage === 'PAIRING') return ['Pairing securely', 'Keep the phone unlocked and the USB cable connected.', 'info-text'];
  if (setup.stage === 'AUTHENTICATING') return ['Securing connection', 'Completing mutual authentication with the phone.', 'info-text'];
  if (device?.phase === 'authorizing') return ['Authorizing', 'Unlock the phone and approve USB debugging if Android asks.', 'info-text'];
  if (gateway?.identity !== 'HARDWARE' || device?.qualification === 'unsupported' || gateway?.qualification === 'unsupported') return ['Unsupported device', 'Qualified hardware required before call controls can be enabled.', 'danger-text'];
  if (gateway?.state === 'stopped') return ['Disconnected', 'gatewayd is stopped. Inspect the installed service and logs before connecting a phone.', 'danger-text'];
  return ['Waiting for phone', 'Connect the phone by USB, unlock it, then open AgentCall and tap Connect desktop.', 'info-text'];
}

async function renderAndroid() {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Android connection', 'Checking authenticated USB transport…');
  workspace.replaceChildren(panel);
  try {
    const [android, overview, stt, tts] = await Promise.all([
      window.gatewayDesktop.read('android'),
      window.gatewayDesktop.read('overview'),
      window.gatewayDesktop.read('stt'),
      window.gatewayDesktop.read('tts'),
    ]);
    if (android?.mode !== 'live' || overview?.mode !== 'live') throw new Error('gateway unavailable');
    const gateway = overview.gateway ?? {};
    const device = android.device ?? {};
    const [label, guidance, tone] = androidGuidance(device, gateway);
    panel.querySelector('.panel-state').textContent = `${label} · ${guidance}`;
    const status = setupCard('Live connection', 'Current phone and recording health from the local gateway service.');
    addStatusRow(status, 'Connection', label, tone);
    addStatusRow(status, 'Transport', device.transport === 'simulator' ? 'SIMULATOR' : device.transport === 'network' ? 'Network TCP' : 'USB only', device.transport === 'simulator' ? 'info-text' : '');
    addStatusRow(status, 'Authentication', device.authenticated ? 'Complete' : 'Not established', device.authenticated ? 'healthy-text' : 'danger-text');
    if (device.transport === 'network') {
      addStatusRow(status, 'Phone host', device.phoneHost ?? 'Not configured', device.phoneHost ? 'healthy-text' : 'warning-text');
      addStatusRow(status, 'Phone port', String(device.phonePort ?? ''), '');
    }
    addStatusRow(status, 'Recording', gateway.recording?.healthy ? 'Healthy' : String(gateway.recording?.reason ?? 'Unavailable'), gateway.recording?.healthy ? 'healthy-text' : 'danger-text');
    const speechConfigured = stt?.mode === 'live' && tts?.mode === 'live'
      && stt.enabled === true && tts.enabled === true
      && stt.active === true && tts.active === true;
    const speechState = gateway.realtime?.healthy
      ? 'Ready'
      : speechConfigured
        ? 'Configured'
        : gateway.realtime?.reason === 'realtime not initialized'
        ? 'Not configured'
        : String(gateway.realtime?.reason ?? 'Not ready');
    addStatusRow(status, 'Speech runtime', speechState, gateway.realtime?.healthy || speechConfigured ? 'healthy-text' : 'info-text');
    const setup = setupCard('Phone setup checklist', 'Complete these steps once, then keep the phone connected while using call features.');
    const checklist = [
      'Install the signed AgentCall APK and compatible device module from this release.',
      'Set AgentCall as the default dialer when Android asks.',
      'Connect the phone by USB and keep USB debugging authorized for this host.',
      'Open AgentCall and tap Connect desktop; pairing completes automatically with no controller secret entry.',
      'Return here and require “Authenticated USB” before placing calls.',
    ];
    for (const [index, text] of checklist.entries()) {
      const item = document.createElement('div');
      item.className = 'check-item';
      const number = document.createElement('span');
      number.className = 'check-index';
      number.textContent = String(index + 1);
      const copy = document.createElement('span');
      copy.textContent = text;
      item.append(number, copy);
      setup.append(item);
    }
    panel.append(status, setup);
  } catch {
    panel.querySelector('.panel-state').textContent = 'UNAVAILABLE · desktop cannot reach the local gatewayd socket';
    panel.append(setupCard('Enroll this desktop operator', 'Ask an administrator to run agentcall-enroll-operator for this user, then start a new login session. The app never changes group membership or starts the gateway automatically.'));
  }
}

const providerOptions = Object.freeze({
  stt: Object.freeze({
    openai: Object.freeze({ label: 'OpenAI', models: Object.freeze([
      { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
      { value: 'gpt-4o-mini-transcribe-2025-12-15', label: 'GPT-4o mini Transcribe (pinned)' },
      { value: 'whisper-1', label: 'Whisper-1' },
    ]), needsCredential: true, icon: 'openai' }),
    elevenlabs: Object.freeze({ label: 'ElevenLabs', models: Object.freeze([{ value: 'scribe_v2_realtime', label: 'Scribe v2 Realtime' }]), needsCredential: true, icon: 'elevenlabs' }),
  }),
  tts: Object.freeze({
    supertonic: Object.freeze({ label: 'Supertonic', models: Object.freeze([{ value: 'supertonic-3', label: 'Supertonic 3' }]), needsCredential: false, icon: 'supertonic' }),
    elevenlabs: Object.freeze({ label: 'ElevenLabs', models: Object.freeze([
      { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
      { value: 'eleven_multilingual_v2', label: 'Multilingual v2' },
      { value: 'eleven_v3', label: 'Eleven v3' },
    ]), needsCredential: true, icon: 'elevenlabs' }),
    openai: Object.freeze({ label: 'OpenAI', models: Object.freeze([
      { value: 'gpt-4o-mini-tts-2025-12-15', label: 'GPT-4o mini TTS (pinned)' },
      { value: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS' },
      { value: 'tts-1', label: 'TTS-1' },
      { value: 'tts-1-hd', label: 'TTS-1 HD' },
    ]), needsCredential: true, icon: 'openai' }),
  }),
});

const languageOptions = Object.freeze([
  ['en', 'English'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['hr', 'Croatian'],
  ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['et', 'Estonian'], ['fi', 'Finnish'],
  ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['hu', 'Hungarian'], ['id', 'Indonesian'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['lv', 'Latvian'], ['lt', 'Lithuanian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['tr', 'Turkish'], ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'], ['fil', 'Filipino'], ['ms', 'Malay'], ['no', 'Norwegian'], ['ta', 'Tamil'],
  ['th', 'Thai'], ['ur', 'Urdu'], ['fa', 'Persian'], ['he', 'Hebrew'], ['na', 'Language neutral'],
].map(([value, label]) => Object.freeze({ value, label })));

const voiceOptions = Object.freeze({
  supertonic: Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'].map((value) => Object.freeze({ value, label: value }))),
  openai: Object.freeze(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((value) => Object.freeze({ value, label: value[0].toUpperCase() + value.slice(1) }))),
});

function field(labelText, control) {
  const nativeControl = ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName);
  const label = document.createElement(nativeControl ? 'label' : 'div');
  label.className = nativeControl ? '' : 'field';
  if (control.type === 'checkbox') label.className = 'checkbox-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function optionSelect(kind, selected) {
  const select = document.createElement('div');
  select.className = 'provider-picker';
  select.setAttribute('role', 'radiogroup');
  select.setAttribute('aria-label', `${kind.toUpperCase()} provider`);
  const values = Object.keys(providerOptions[kind]);
  select.value = values.includes(selected) ? selected : values[0];
  for (const [value, metadata] of Object.entries(providerOptions[kind])) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'provider-option';
    option.dataset.value = value;
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-label', `Use ${metadata.label} for ${kind.toUpperCase()}`);
    const mark = brandMark(metadata.icon);
    mark.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.textContent = metadata.label;
    option.append(mark, copy);
    const syncSelected = () => {
      const active = select.value === value;
      option.classList.toggle('selected', active);
      option.setAttribute('aria-checked', String(active));
    };
    const activate = () => {
      if (select.value === value) {
        syncSelected();
        return;
      }
      select.value = value;
      select.querySelectorAll('.provider-option').forEach((item) => {
        const active = item.dataset.value === value;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-checked', String(active));
      });
      select.onSelectionChange?.();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    option.addEventListener('click', activate);
    syncSelected();
    select.append(option);
  }
  return select;
}

function choiceSelect(options, selected, ariaLabel) {
  const root = document.createElement('div');
  root.className = 'choice-select';
  root.setAttribute('aria-label', ariaLabel);
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'choice-trigger';
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'choice-menu';
  menu.hidden = true;
  root.append(trigger, menu);
  root.setOptions = (nextOptions, preferred = '') => {
    const values = nextOptions.map((option) => option.value);
    root.value = values.includes(preferred) ? preferred : values[0] ?? '';
    menu.replaceChildren();
    for (const item of nextOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-option';
      button.dataset.value = item.value;
      button.textContent = item.label;
      if (item.value === root.value) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        root.value = item.value;
        trigger.textContent = item.label;
        menu.querySelectorAll('.choice-option').forEach((option) => {
          if (option.dataset.value === item.value) option.setAttribute('aria-current', 'true'); else option.removeAttribute('aria-current');
        });
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        root.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.append(button);
    }
    trigger.textContent = nextOptions.find((option) => option.value === root.value)?.label ?? 'Choose';
  };
  trigger.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute('aria-expanded', String(!menu.hidden));
  });
  root.setOptions(options, selected);
  return root;
}

function createSpeechCard(kind, status) {
  const title = kind.toUpperCase();
  const defaultProvider = kind === 'stt' ? 'openai' : 'supertonic';
  const card = document.createElement('form');
  card.className = 'speech-card';
  card.dataset.kind = kind;
  const heading = document.createElement('h3');
  heading.textContent = kind === 'stt' ? 'Speech to text' : 'Text to speech';
  const brandHeading = document.createElement('div');
  brandHeading.className = 'brand-heading';
  const configured = document.createElement('p');
  configured.className = status.active ? 'healthy-text' : status.configured ? 'warning-text' : 'muted';
  configured.textContent = !status.configured
    ? 'Not configured'
    : status.active
      ? `Active now · ${status.provider} · ${status.model}`
      : status.state === 'restart-required'
        ? `Pending restart · ${status.provider} · ${status.model}`
        : `Configured · ${status.provider} · ${status.model}`;
  const provider = optionSelect(kind, status.provider ?? defaultProvider);
  let providerMark = brandMark(providerOptions[kind][provider.value].icon);
  brandHeading.append(providerMark, heading);
  const model = choiceSelect(providerOptions[kind][provider.value].models, status.model, `${title} model`);
  const language = choiceSelect(languageOptions, status.language ?? 'en', `${title} language`);
  const voiceHost = document.createElement('div');
  let voice;
  const voiceValue = () => voice.value;
  const credential = document.createElement('input');
  credential.type = 'password';
  credential.autocomplete = 'off';
  credential.maxLength = 4096;
  credential.placeholder = status.configured ? 'Enter a replacement credential' : 'Required for cloud provider';
  const zeroRetention = document.createElement('input');
  zeroRetention.type = 'checkbox';
  zeroRetention.checked = status.zeroRetention ?? true;
  const feedback = document.createElement('p');
  feedback.className = 'form-feedback';
  feedback.setAttribute('role', 'status');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = `Save ${title}`;
  const checkHealth = document.createElement('button');
  checkHealth.type = 'button';
  checkHealth.className = 'secondary';
  checkHealth.textContent = 'Check health';
  checkHealth.disabled = status.active !== true;
  const healthFeedback = document.createElement('p');
  healthFeedback.className = 'form-feedback muted';
  healthFeedback.setAttribute('role', 'status');
  healthFeedback.textContent = status.state === 'restart-required'
    ? 'Restart gatewayd before checking this saved provider'
    : status.active
      ? 'Health check not run'
      : 'Configure and activate before checking health';
  let catalogGeneration = 0;
  let synchronizedProvider = '';

  const matchesActiveSnapshot = () => status.active === true
    && provider.value === status.provider
    && model.value === status.model
    && language.value === status.language
    && (kind !== 'tts' || voiceValue() === status.voice)
    && credential.value === '';
  const syncHealthAvailability = () => {
    checkHealth.disabled = !matchesActiveSnapshot();
    if (status.active && checkHealth.disabled) {
      healthFeedback.className = 'form-feedback warning-text';
      healthFeedback.textContent = 'Save changes and restart gatewayd before checking these values';
    }
  };
  const retentionField = field('Zero-retention mode for ElevenLabs', zeroRetention);
  const credentialField = field('API credential · write-only', credential);
  const syncProvider = () => {
    const generation = ++catalogGeneration;
    const metadata = providerOptions[kind][provider.value];
    const providerChanged = synchronizedProvider !== provider.value;
    const nextMark = brandMark(metadata.icon);
    providerMark.replaceWith(nextMark);
    providerMark = nextMark;
    if (providerChanged) {
      model.setOptions(metadata.models, provider.value === status.provider ? status.model : metadata.models[0].value);
      synchronizedProvider = provider.value;
    }
    credential.required = metadata.needsCredential;
    credential.disabled = !metadata.needsCredential;
    zeroRetention.disabled = provider.value !== 'elevenlabs';
    retentionField.hidden = provider.value !== 'elevenlabs';
    credentialField.hidden = !metadata.needsCredential;
    if (!metadata.needsCredential) credential.value = '';
    if (kind === 'tts') {
      const providerDefaultVoice = provider.value === 'openai' ? 'alloy'
        : provider.value === 'supertonic' ? 'F1' : '';
      const previousVoice = provider.value === status.provider
        ? status.voice || providerDefaultVoice
        : providerDefaultVoice;
      if (provider.value === 'elevenlabs') {
        voice = document.createElement('input');
        voice.type = 'text';
        voice.maxLength = 128;
        voice.placeholder = 'Choose an account voice ID';
        voice.value = provider.value === status.provider ? status.voice ?? '' : '';
        voice.addEventListener('input', syncHealthAvailability);
      } else {
        voice = choiceSelect(voiceOptions[provider.value], previousVoice, 'TTS voice');
        voice.addEventListener('change', syncHealthAvailability);
      }
      voiceHost.replaceChildren(voice);
    }
    syncHealthAvailability();
    const requestedModel = model.value;
    const requestedLanguage = language.value;
    feedback.className = 'form-feedback muted';
    feedback.textContent = 'Loading provider choices…';
    void window.gatewayDesktop.loadProviderCatalog(kind, provider.value, requestedModel).then((catalog) => {
      if (generation !== catalogGeneration || catalog?.provider !== provider.value || catalog?.kind !== kind) return;
      const modelLabels = new Map(metadata.models.map((item) => [item.value, item.label]));
      const models = Array.isArray(catalog.models) ? catalog.models
        .filter((value) => typeof value === 'string' && value.length <= 128)
        .map((value) => ({ value, label: modelLabels.get(value) ?? value })) : metadata.models;
      if (models.length > 0) model.setOptions(models, requestedModel);
      const languageLabels = new Map(languageOptions.map((item) => [item.value, item.label]));
      const languages = Array.isArray(catalog.languages) ? catalog.languages
        .filter((value) => typeof value === 'string' && /^[a-z]{2,3}$/.test(value))
        .map((value) => ({ value, label: languageLabels.get(value) ?? value.toUpperCase() })) : languageOptions;
      if (languages.length > 0) language.setOptions(languages, requestedLanguage);
      if (kind === 'tts' && Array.isArray(catalog.voices) && catalog.voices.length > 0) {
        const voices = catalog.voices.slice(0, 100).flatMap((item) => {
          const value = typeof item === 'string' ? item : item?.value;
          const label = typeof item === 'string' ? item : item?.label;
          return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
            ? [{ value, label: typeof label === 'string' && label.length <= 128 ? label : value }]
            : [];
        });
        const configuredVoice = provider.value === status.provider ? status.voice : '';
        if (configuredVoice && !voices.some((item) => item.value === configuredVoice)) {
          voices.unshift({ value: status.voice, label: `Current · ${status.voice}` });
        }
        voice = choiceSelect(voices, configuredVoice || previousVoice || voices[0]?.value, 'TTS voice');
        voice.addEventListener('change', syncHealthAvailability);
        voiceHost.replaceChildren(voice);
      }
      feedback.className = 'form-feedback muted';
      feedback.textContent = catalog.modelState === 'credential-required'
        ? `Save a ${metadata.label} credential to load available models${catalog.voiceState === 'credential-required' ? ' and account voices' : ''}.`
        : catalog.voiceState === 'credential-required'
        ? 'Save an ElevenLabs credential to load account voices.'
        : catalog.modelState === 'unavailable' || catalog.languageState === 'unavailable' || catalog.voiceState === 'unavailable'
          ? 'Supported choices loaded. Live provider details are temporarily unavailable.'
          : catalog.modelState === 'built-in' || catalog.languageState === 'built-in'
            ? catalog.voiceState === 'ready' && Array.isArray(catalog.voices) && catalog.voices.length > 0
              ? 'Supported models and languages loaded. Account voices loaded live.'
              : 'Supported models and languages loaded.'
          : 'Provider models, languages, and voices loaded.';
      syncHealthAvailability();
    }).catch(() => {
      if (generation !== catalogGeneration) return;
      feedback.className = 'form-feedback warning-text';
      feedback.textContent = 'Could not refresh provider choices. Built-in supported choices remain available.';
    });
  };
  provider.onSelectionChange = syncProvider;
  model.addEventListener('change', syncProvider);
  language.addEventListener('change', syncHealthAvailability);
  credential.addEventListener('input', syncHealthAvailability);
  syncProvider();

  card.append(
    brandHeading,
    configured,
    field(`${title} provider`, provider),
    field('Model', model),
    field('Language', language),
  );
  if (kind === 'tts') card.append(field('Voice', voiceHost));
  card.append(retentionField);
  card.append(credentialField, save, feedback, checkHealth, healthFeedback);
  checkHealth.addEventListener('click', async () => {
    if (!matchesActiveSnapshot()) return;
    checkHealth.disabled = true;
    healthFeedback.className = 'form-feedback';
    healthFeedback.textContent = 'Checking active provider…';
    try {
      const result = await window.gatewayDesktop.checkProviderHealth(kind);
      const rate = Number.isInteger(result.sampleRate) ? ` · ${result.sampleRate} Hz` : '';
      if (result.healthy) {
        healthFeedback.className = 'form-feedback healthy-text';
        healthFeedback.textContent = result.scope === 'credential'
          ? `Credential available · ${result.model}${rate}`
          : `Endpoint/model verified · ${result.model}${rate}`;
      } else {
        healthFeedback.className = 'form-feedback danger-text';
        healthFeedback.textContent = `Health check failed · ${result.reason ?? 'provider unavailable'}`;
      }
    } catch {
      healthFeedback.className = 'form-feedback danger-text';
      healthFeedback.textContent = 'Health check unavailable · local gatewayd is not connected';
    } finally {
      syncHealthAvailability();
    }
  });
  card.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    feedback.className = 'form-feedback';
    feedback.textContent = 'Saving securely through local gatewayd…';
    const request = {
      kind,
      provider: provider.value,
      model: model.value,
      language: language.value,
      apiKey: credential.value,
      ...(kind === 'tts' ? { voice: voiceValue() } : {}),
      ...(provider.value === 'elevenlabs' ? { zeroRetention: zeroRetention.checked } : {}),
    };
    try {
      const receipt = await window.gatewayDesktop.saveSecret(request);
      if (receipt.accepted !== true || receipt.configured !== true) throw new Error('provider settings rejected');
      credential.value = '';
      feedback.className = 'form-feedback healthy-text';
      feedback.textContent = receipt.restartRequired
        ? 'Saved · pending gateway restart'
        : 'Saved';
      await renderSpeech();
    } catch {
      feedback.className = 'form-feedback danger-text';
      feedback.textContent = 'Could not save · local gatewayd is unavailable or rejected the settings';
    } finally {
      save.disabled = false;
    }
  });
  return card;
}

async function renderSpeech() {
  const workspace = document.querySelector('.workspace-pane');
  workspace.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'route-panel speech-settings';
  const heading = document.createElement('h2');
  heading.textContent = 'Speech';
  const intro = document.createElement('p');
  intro.className = 'panel-state';
  intro.textContent = 'Configure STT and TTS independently. Credentials are write-only and stored by local gatewayd.';
  const grid = document.createElement('div');
  grid.className = 'speech-grid';
  panel.append(heading, intro, grid);
  workspace.append(panel);
  try {
    const [stt, tts] = await Promise.all([
      window.gatewayDesktop.read('stt'),
      window.gatewayDesktop.read('tts'),
    ]);
    if (stt?.mode !== 'live' || tts?.mode !== 'live') {
      intro.textContent = 'UNAVAILABLE · install and start local gatewayd before configuring speech';
      return;
    }
    grid.append(createSpeechCard('stt', stt), createSpeechCard('tts', tts));
    const pairTest = document.createElement('section');
    pairTest.className = 'speech-pair-test';
    const pairTestButton = document.createElement('button');
    pairTestButton.type = 'button';
    pairTestButton.className = 'secondary';
    pairTestButton.textContent = 'Test active speech pair';
    const pairTestFeedback = document.createElement('p');
    pairTestFeedback.className = 'form-feedback muted';
    pairTestFeedback.setAttribute('role', 'status');
    const pairActive = stt.state === 'active' && tts.state === 'active' && stt.active === true && tts.active === true;
    pairTestButton.disabled = !pairActive;
    pairTestFeedback.textContent = pairActive
      ? 'Synthesizes a fixed phrase, transcribes it, and opens native WAV playback.'
      : 'Complete setup and restart gatewayd before testing the active pair.';
    pairTest.append(pairTestButton, pairTestFeedback);
    panel.append(pairTest);
    pairTestButton.addEventListener('click', async () => {
      if (!pairActive) return;
      pairTestButton.disabled = true;
      pairTestFeedback.className = 'form-feedback';
      pairTestFeedback.textContent = 'Synthesizing, transcribing, and opening playback…';
      try {
        const result = await window.gatewayDesktop.testProviders();
        pairTestFeedback.className = result.healthy
          ? 'form-feedback healthy-text'
          : 'form-feedback danger-text';
        pairTestFeedback.textContent = result.healthy
          ? `Expected phrase: ${result.phrase} · Transcript: ${result.transcript} · Playback opened: ${result.playbackOpened ? 'yes' : 'no'}`
          : 'Speech pair test failed';
      } catch {
        pairTestFeedback.className = 'form-feedback danger-text';
        pairTestFeedback.textContent = 'Speech pair test unavailable · verify active providers and local gatewayd';
      } finally {
        pairTestButton.disabled = !pairActive;
      }
    });
    const notice = document.createElement('p');
    notice.className = 'restart-notice';
    if (stt.state === 'restart-required' || tts.state === 'restart-required') {
      notice.textContent = 'Pending restart · saved settings will become active after gatewayd restarts.';
      panel.append(notice);
    } else if (stt.state === 'incomplete' || tts.state === 'incomplete') {
      notice.textContent = 'Complete STT and TTS setup before realtime speech can start.';
      panel.append(notice);
    } else if (stt.state === 'active' && tts.state === 'active') {
      notice.className = 'restart-notice healthy-text';
      notice.textContent = 'Active now · gatewayd is using these speech providers.';
      panel.append(notice);
    }
  } catch {
    intro.textContent = 'UNAVAILABLE · local gatewayd is not connected';
  }
}

async function renderPolicy() {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Call & privacy policy', 'Clear protections for calls, recordings, phone data, and speech providers.');
  const grid = document.createElement('div');
  grid.className = 'policy-grid';
  panel.append(grid);
  workspace.replaceChildren(panel);

  const calls = setupCard('Outbound calls', 'The desktop asks for confirmation before each new call. Emergency destinations are always blocked, and premium or international dialing requires explicit policy approval.');
  addStatusRow(calls, 'Manual confirmation', 'Required', 'healthy-text');
  addStatusRow(calls, 'Emergency numbers', 'Blocked');
  addStatusRow(calls, 'Automatic dialing', 'Off by default');

  const privacy = setupCard('Private phone data', 'Contacts and call history stay in a local desktop mirror so the interface remains useful when the phone is briefly disconnected.');
  addStatusRow(privacy, 'Transport', 'USB only', 'healthy-text');
  addStatusRow(privacy, 'Cloud synchronization', 'Not used');
  addStatusRow(privacy, 'Offline mirror', 'Local desktop');

  const speech = setupCard('Speech providers', 'STT and TTS are selected independently. Cloud credentials are submitted through a write-only interface and are never shown back in the app.');
  addStatusRow(speech, 'Provider fallback', 'Disabled');
  addStatusRow(speech, 'API credentials', 'Write-only');
  addStatusRow(speech, 'Local TTS option', 'Supertonic');

  const recording = setupCard('Recording protection', 'A call can start only when the desktop recorder is ready. Finalized files include integrity metadata and remain subject to operator-controlled retention.');
  try {
    const overview = await window.gatewayDesktop.read('overview');
    const healthy = overview?.mode === 'live' && overview.gateway?.recording?.healthy === true;
    addStatusRow(recording, 'Recorder', healthy ? 'Ready' : 'Needs attention', healthy ? 'healthy-text' : 'warning-text');
  } catch {
    addStatusRow(recording, 'Recorder', 'Status unavailable', 'warning-text');
  }
  addStatusRow(recording, 'Consent', 'Required');
  addStatusRow(recording, 'Integrity manifest', 'Required');
  grid.append(calls, recording, privacy, speech);
}

async function renderSettings() {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Desktop settings', 'Manage the local desktop service, phone synchronization, and how Hermes or OpenClaw handles incoming calls.');
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  panel.append(grid);
  workspace.replaceChildren(panel);

  const network = setupCard('Network mode', 'Connect the gateway to a phone over Tailscale, LAN, or the internet instead of USB. The phone runs the network listener and the desktop reaches it by hostname or IP.');
  const networkModeRow = document.createElement('div');
  networkModeRow.className = 'network-mode-row';
  const networkModeLabel = document.createElement('label');
  networkModeLabel.className = 'toggle-switch';
  networkModeLabel.setAttribute('aria-label', 'Enable network mode');
  const networkMode = document.createElement('input');
  networkMode.type = 'checkbox';
  const networkModeSlider = document.createElement('span');
  networkModeSlider.setAttribute('aria-hidden', 'true');
  networkModeLabel.append(networkMode, networkModeSlider);
  const networkModeCopy = document.createElement('div');
  const networkModeTitle = document.createElement('strong');
  networkModeTitle.textContent = 'Network transport';
  const networkModeDescription = document.createElement('span');
  networkModeDescription.textContent = 'When enabled, gatewayd connects to the phone over TCP. Disable to use USB/ADB instead.';
  networkModeCopy.append(networkModeTitle, networkModeDescription);
  networkModeRow.append(networkModeCopy, networkModeLabel);
  const hostRow = document.createElement('div');
  hostRow.className = 'field';
  const hostLabel = document.createElement('label');
  hostLabel.setAttribute('for', 'network-host');
  hostLabel.textContent = 'Phone host';
  const hostInput = document.createElement('input');
  hostInput.type = 'text';
  hostInput.id = 'network-host';
  hostInput.placeholder = 'e.g. 100.85.23.15 or mypc.tailnet-ts.net';
  const hostDescription = document.createElement('small');
  hostDescription.textContent = 'Tailscale IP, LAN IP, or hostname reachable from this desktop.';
  hostRow.append(hostLabel, hostInput, hostDescription);
  const portRow = document.createElement('div');
  portRow.className = 'field';
  const portLabel = document.createElement('label');
  portLabel.setAttribute('for', 'network-port');
  portLabel.textContent = 'Phone port';
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.id = 'network-port';
  portInput.min = 1024;
  portInput.max = 65535;
  portInput.value = '27183';
  const portDescription = document.createElement('small');
  portDescription.textContent = 'The TCP port the phone network listener binds to.';
  portRow.append(portLabel, portInput, portDescription);
  const networkActions = document.createElement('div');
  networkActions.className = 'network-actions';
  const networkFeedback = document.createElement('p');
  networkFeedback.className = 'form-feedback muted';
  networkFeedback.setAttribute('role', 'status');
  const networkSave = document.createElement('button');
  networkSave.type = 'button';
  networkSave.className = 'secondary';
  networkSave.textContent = 'Save network settings';
  networkActions.append(networkFeedback, networkSave);
  network.append(networkModeRow, hostRow, portRow, networkActions);
  const storage = setupCard('Recordings & privacy', 'Finalized recordings are managed by the gateway service. Speech credentials remain write-only and are never rendered here.');
  addStatusRow(storage, 'Credential display', 'Never');
  addStatusRow(storage, 'Release', '1.0.1');
  const project = setupCard(
    'AgentCall on GitHub',
    'Read the setup guide, download releases, report issues, and contribute to the project.',
  );
  project.classList.add('project-card');
  const projectLink = document.createElement('button');
  projectLink.type = 'button';
  projectLink.className = 'project-link';
  const projectIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  projectIcon.setAttribute('aria-hidden', 'true');
  const projectIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  projectIconUse.setAttribute('href', '#icon-github');
  projectIcon.append(projectIconUse);
  const projectCopy = document.createElement('span');
  const projectName = document.createElement('strong');
  projectName.textContent = 'sidinsearch / AgentCall';
  const projectHint = document.createElement('small');
  projectHint.textContent = 'Open the repository in your browser \u2197';
  projectCopy.append(projectName, projectHint);
  projectLink.append(projectIcon, projectCopy);
  projectLink.addEventListener('click', async () => {
    projectLink.disabled = true;
    try {
      await window.gatewayDesktop.openProjectPage();
    } finally {
      projectLink.disabled = false;
    }
  });
  project.append(projectLink);

  const receptionist = setupCard(
    'AI answers incoming calls',
    'When enabled, AgentCall Desktop keeps Hermes ready to answer on your behalf. OpenClaw can use the same receptionist mode through the local MCP launcher. AgentCall passes these instructions, the saved contact name, and consented caller history to the agent.',
  );
  receptionist.classList.add('receptionist-card');
  const modeRow = document.createElement('div');
  modeRow.className = 'receptionist-mode-row';
  const modeCopy = document.createElement('div');
  const modeTitle = document.createElement('strong');
  modeTitle.textContent = 'Receptionist mode';
  const modeDescription = document.createElement('span');
  modeDescription.textContent = 'Off by default. Calls remain manual when disabled or when Hermes and the speech providers are unavailable.';
  modeCopy.append(modeTitle, modeDescription);
  const modeLabel = document.createElement('label');
  modeLabel.className = 'toggle-switch';
  modeLabel.setAttribute('aria-label', 'Allow AI to answer incoming calls');
  const mode = document.createElement('input');
  mode.type = 'checkbox';
  const slider = document.createElement('span');
  slider.setAttribute('aria-hidden', 'true');
  modeLabel.append(mode, slider);
  modeRow.append(modeCopy, modeLabel);

  const instructionsLabel = document.createElement('label');
  instructionsLabel.className = 'receptionist-instructions';
  const instructionsHeading = document.createElement('span');
  instructionsHeading.textContent = 'Context and instructions for Hermes / OpenClaw';
  const instructions = document.createElement('textarea');
  instructions.rows = 7;
  instructions.maxLength = 2_000;
  instructions.placeholder = 'Example: I am in a meeting until 4 PM. Greet the caller, explain that I will call back, ask for their name and reason for calling, and do not discuss project details.';
  instructions.setAttribute('aria-describedby', 'receptionist-help receptionist-count');
  const instructionsHelp = document.createElement('small');
  instructionsHelp.id = 'receptionist-help';
  instructionsHelp.textContent = 'Write the situation, what the agent may say or ask, and any boundaries it must follow.';
  const count = document.createElement('small');
  count.id = 'receptionist-count';
  count.className = 'receptionist-count';
  const updateCount = () => { count.textContent = `${instructions.value.length} / 2000`; };
  instructions.addEventListener('input', updateCount);
  instructionsLabel.append(instructionsHeading, instructions, instructionsHelp, count);

  const actions = document.createElement('div');
  actions.className = 'receptionist-actions';
  const feedback = document.createElement('p');
  feedback.className = 'form-feedback muted';
  feedback.setAttribute('role', 'status');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save receptionist settings';
  actions.append(feedback, save);
  receptionist.append(modeRow, instructionsLabel, actions);

  try {
    const [overview, contactsData, callLogData, answeringData] = await Promise.all([
      window.gatewayDesktop.read('overview'),
      window.gatewayDesktop.read('contacts'),
      window.gatewayDesktop.read('callLog'),
      window.gatewayDesktop.read('agentAnswering'),
    ]);
    const live = overview?.mode === 'live';
    const device = live ? overview.gateway?.device ?? {} : {};
    addStatusRow(desktop, 'Gateway service', live ? 'Running' : 'Unavailable', live ? 'healthy-text' : 'warning-text');
    addStatusRow(desktop, 'Phone', device.authenticated ? (device.transport === 'network' ? 'Authenticated network' : 'Authenticated USB') : 'Not connected', device.authenticated ? 'healthy-text' : 'warning-text');
    addStatusRow(desktop, 'Control channel', device.transport === 'network' ? 'Network TCP' : 'Local IPC');
    const networkConfig = await window.gatewayDesktop.read('networkConfig') ?? {};
    networkMode.checked = networkConfig.enabled === true;
    hostInput.value = networkConfig.host ?? '';
    portInput.value = String(networkConfig.port ?? 27183);
    hostInput.disabled = !networkMode.checked;
    portInput.disabled = !networkMode.checked;
    const contacts = contactsData?.sync ?? {};
    const calls = callLogData?.sync ?? {};
    addStatusRow(sync, 'Contacts', contacts.state === 'ready' ? `${contacts.count} ready` : String(contacts.state ?? 'Waiting'), contacts.state === 'ready' ? 'healthy-text' : 'warning-text');
    addStatusRow(sync, 'Call history', calls.state === 'ready' ? `${calls.count} ready` : String(calls.state ?? 'Waiting'), calls.state === 'ready' ? 'healthy-text' : 'warning-text');
    addStatusRow(sync, 'Refresh', 'Automatic after connection');
    mode.checked = answeringData?.mode === 'live' && answeringData.enabled === true;
    instructions.value = answeringData?.mode === 'live' ? String(answeringData.instructions ?? '') : '';
    feedback.textContent = mode.checked ? 'Enabled · keeping the Hermes receptionist ready' : 'Disabled · incoming calls remain manual';
    feedback.className = `form-feedback ${mode.checked ? 'healthy-text' : 'muted'}`;
    updateCount();
  } catch {
    addStatusRow(desktop, 'Gateway service', 'Unavailable', 'warning-text');
    addStatusRow(sync, 'Synchronization', 'Status unavailable', 'warning-text');
    mode.disabled = true;
    instructions.disabled = true;
    save.disabled = true;
    feedback.textContent = 'Receptionist settings are unavailable while the gateway service is offline.';
    feedback.className = 'form-feedback warning-text';
    updateCount();
  }
  save.addEventListener('click', async () => {
    save.disabled = true;
    feedback.textContent = 'Saving locally…';
    feedback.className = 'form-feedback muted';
    try {
      const receipt = await window.gatewayDesktop.saveAgentAnswering({
        enabled: mode.checked,
        instructions: instructions.value,
      });
      if (receipt?.accepted !== true) throw new Error('settings rejected');
      mode.checked = receipt.enabled === true;
      instructions.value = String(receipt.instructions ?? '');
      updateCount();
      feedback.textContent = mode.checked
        ? 'Enabled · starting the Hermes receptionist'
        : 'Disabled · incoming calls remain manual';
      feedback.className = `form-feedback ${mode.checked ? 'healthy-text' : 'muted'}`;
    } catch {
      feedback.textContent = 'Could not save · check the local gateway service';
      feedback.className = 'form-feedback danger-text';
    } finally {
      save.disabled = false;
    }
  });
  networkSave.addEventListener('click', async () => {
    networkSave.disabled = true;
    networkFeedback.textContent = 'Saving network settings…';
    networkFeedback.className = 'form-feedback muted';
    try {
      const mode = networkMode.checked;
      const host = hostInput.value.trim();
      const port = parseInt(portInput.value, 10);
      if (mode && (!host || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.?)+$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host))) {
        throw new Error('Invalid host');
      }
      if (mode && (isNaN(port) || port < 1024 || port > 65535)) {
        throw new Error('Invalid port');
      }
      const receipt = await window.gatewayDesktop.configureNetwork({ enabled: mode, host, port });
      if (receipt?.accepted !== true) throw new Error('settings rejected');
      networkFeedback.textContent = mode
        ? `Enabled · connecting to ${host ?? 'phone'}:${port} over network`
        : 'Disabled · will use USB/ADB transport';
      networkFeedback.className = `form-feedback ${mode ? 'healthy-text' : 'muted'}`;
    } catch {
      networkFeedback.textContent = 'Could not save · check the local gateway service';
      networkFeedback.className = 'form-feedback danger-text';
    } finally {
      networkSave.disabled = false;
    }
  });
  grid.append(network, receptionist, desktop, sync, storage, project);
}

let phoneCalls = [];
let selectedPhoneCall = null;
let phoneCallSync = null;
let preparedOutboundCall = null;

function prepareOutboundCall(number, name = '') {
  preparedOutboundCall = { number: String(number ?? '').trim(), name: String(name ?? '').trim() };
  void selectRoute('live-call');
}

function recordingFeedback(message = '', danger = false) {
  const feedback = document.querySelector('#recording-action-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = `action-feedback${danger ? ' danger-text' : ''}`;
}

async function renderCalls() {
  const workspace = document.querySelector('.workspace-pane');
  workspace.replaceChildren(document.querySelector('#calls-template').content.cloneNode(true));
  document.querySelector('#list-title').textContent = 'Calls';
  document.querySelector('#list-filter').textContent = 'Phone log';
  const search = document.querySelector('.search input');
  search.placeholder = 'Search phone calls';
  search.setAttribute('aria-label', 'Search phone calls');
  await renderPhoneCallLog();
}

function syncLabel(sync) {
  const state = String(sync?.state ?? 'never');
  const timestamp = typeof sync?.syncedAt === 'string' ? Date.parse(sync.syncedAt) : NaN;
  const when = Number.isFinite(timestamp) ? ` · ${new Date(timestamp).toLocaleString()}` : '';
  return `${state}${when}`;
}

function callDuration(row) {
  const seconds = Math.max(0, Number.parseInt(row.durationSeconds, 10) || 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function callWhen(row) {
  const timestamp = Number.parseInt(row.timestampMillis, 10);
  return Number.isSafeInteger(timestamp) ? new Date(timestamp).toLocaleString() : 'Time unavailable';
}

function showPhoneCall(row) {
  selectedPhoneCall = row;
  document.querySelectorAll('.call-row').forEach((item) => item.classList.toggle('selected', item.dataset.call === row.id));
  document.querySelectorAll('.call-row-shell').forEach((item) => {
    item.classList.toggle('selected', item.querySelector('.call-row')?.dataset.call === row.id);
  });
  const header = document.querySelector('#call-history-header');
  header.querySelector('h2').textContent = row.name || row.number;
  header.querySelector('p').textContent = `${row.kind} · ${callWhen(row)}`;
  const values = [
    ['Direction', 'Phone call type', row.kind],
    ['Duration', 'Reported by Android', callDuration(row)],
    ['Sync', 'Local offline mirror', String(phoneCallSync?.state ?? 'never')],
  ];
  [...document.querySelector('#call-history-summary').children].forEach((item, index) => {
    item.querySelector('strong').textContent = values[index][0];
    item.querySelector('span').textContent = values[index][1];
    item.querySelector('b').textContent = values[index][2];
  });
  const detail = document.querySelector('#call-history-detail');
  detail.replaceChildren();
  for (const text of [
    `Name · ${row.name || 'Unknown contact'}`, `Number · ${row.number}`, `Direction · ${row.kind}`,
    `Started · ${callWhen(row)}`, `Duration · ${callDuration(row)}`, `Mirror · ${syncLabel(phoneCallSync)}`,
  ]) {
    const line = document.createElement('p');
    line.textContent = text;
    detail.append(line);
  }
  const inspector = document.querySelector('#inspector-integrity');
  const mirror = document.querySelector('#inspector-retention');
  if (inspector) inspector.textContent = `${row.kind} · ${callDuration(row)} · ${callWhen(row)}`;
  if (mirror) mirror.textContent = `Phone log ${syncLabel(phoneCallSync)}`;
}

function renderPhoneCallRows(query = '') {
  const list = document.querySelector('#call-list');
  const state = document.querySelector('#call-list-state');
  list.replaceChildren();
  const normalized = query.trim().toLowerCase();
  const visible = phoneCalls.filter((row) => !normalized
    || row.name.toLowerCase().includes(normalized) || row.number.includes(normalized) || row.kind.includes(normalized));
  state.hidden = visible.length > 0;
  state.textContent = phoneCalls.length === 0
    ? `No synchronized phone calls · ${syncLabel(phoneCallSync)}` : 'No phone calls match this search';
  for (const rowData of visible) {
    const shell = document.createElement('article');
    shell.className = 'call-row-shell';
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'call-row'; row.dataset.call = rowData.id;
    const avatar = document.createElement('span');
    avatar.className = 'avatar unknown';
    avatar.textContent = rowData.kind === 'incoming' ? '↙' : rowData.kind === 'outgoing' ? '↗' : '×';
    const copy = document.createElement('span'); copy.className = 'row-copy';
    const title = document.createElement('strong'); title.textContent = rowData.name || rowData.number;
    const detail = document.createElement('small');
    detail.textContent = `${rowData.number} · ${rowData.kind} · ${callDuration(rowData)}`;
    copy.append(title, detail);
    const time = document.createElement('time'); time.textContent = callWhen(rowData);
    row.append(avatar, copy, time);
    row.addEventListener('click', () => showPhoneCall(rowData));
    const callButton = document.createElement('button');
    callButton.type = 'button'; callButton.className = 'row-call-button compact';
    callButton.setAttribute('aria-label', `Prepare a call to ${rowData.name || rowData.number}`);
    callButton.title = 'Prepare call';
    const callIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    callIcon.setAttribute('aria-hidden', 'true');
    const callIconUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    callIconUse.setAttribute('href', '#icon-calls');
    callIcon.append(callIconUse); callButton.append(callIcon);
    callButton.addEventListener('click', () => prepareOutboundCall(rowData.number, rowData.name));
    shell.append(row, callButton);
    list.append(shell);
  }
}

async function renderPhoneCallLog() {
  const state = document.querySelector('#call-list-state');
  state.hidden = false; state.textContent = 'Loading synchronized phone calls…';
  try {
    const [data] = await Promise.all([
      window.gatewayDesktop.read('callLog'),
      refreshRuntimeStatus(),
    ]);
    if (data?.mode !== 'live' || !Array.isArray(data.rows)) throw new Error('call log unavailable');
    phoneCalls = data.rows.slice(0, 200); phoneCallSync = data.sync ?? null;
    document.querySelector('#call-log-feedback').textContent = `Phone call log · ${syncLabel(phoneCallSync)}`;
    renderPhoneCallRows(document.querySelector('.search input')?.value ?? '');
    if (phoneCalls[0]) showPhoneCall(phoneCalls[0]);
  } catch {
    phoneCalls = []; phoneCallSync = null; renderPhoneCallRows();
    state.hidden = false; state.textContent = 'UNAVAILABLE · local phone call mirror is not connected';
  }
}

async function renderContacts() {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Contacts', 'Loading synchronized contacts…');
  const search = document.createElement('input');
  search.type = 'search'; search.className = 'contact-search'; search.placeholder = 'Search contacts';
  search.setAttribute('aria-label', 'Search contacts');
  const list = document.createElement('div'); list.className = 'contact-list';
  panel.append(search, list); workspace.replaceChildren(panel);
  try {
    const data = await window.gatewayDesktop.read('contacts');
    if (data?.mode !== 'live' || !Array.isArray(data.rows)) throw new Error('contacts unavailable');
    const contacts = data.rows.slice(0, 500);
    panel.querySelector('.panel-state').textContent = `${contacts.length} contacts · ${syncLabel(data.sync)}`;
    const draw = () => {
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const visible = contacts.filter((row) => !query || row.name.toLowerCase().includes(query) || row.number.includes(query));
      if (visible.length === 0) {
        const empty = document.createElement('p'); empty.className = 'empty-state';
        empty.textContent = contacts.length === 0 ? 'No synchronized contacts' : 'No contacts match this search';
        list.append(empty);
      }
      for (const contact of visible) {
        const row = document.createElement('article'); row.className = 'contact-row';
        const copy = document.createElement('div'); copy.className = 'contact-copy';
        const name = document.createElement('strong'); name.textContent = contact.name || 'Unknown contact';
        const number = document.createElement('span'); number.textContent = contact.number;
        copy.append(name, number);
        const callButton = document.createElement('button');
        callButton.type = 'button'; callButton.className = 'row-call-button'; callButton.textContent = 'Call';
        callButton.setAttribute('aria-label', `Prepare a call to ${contact.name || contact.number}`);
        callButton.addEventListener('click', () => prepareOutboundCall(contact.number, contact.name));
        row.append(copy, callButton); list.append(row);
      }
    };
    search.addEventListener('input', draw); draw();
  } catch {
    panel.querySelector('.panel-state').textContent = 'UNAVAILABLE · local contacts mirror is not connected';
  }
}

function callReadiness(status) {
  if (status?.identity !== 'HARDWARE' || status?.simulator === true || status?.device?.qualification === 'unsupported') return 'Qualified hardware required';
  if (!status.device?.connected || !status.device?.authenticated || status.device?.phase !== 'ready') return 'Authenticated USB connection required';
  if (status.recording?.healthy !== true) return 'Recording health required';
  return '';
}

async function renderLiveCall(snapshot = null) {
  const workspace = document.querySelector('.workspace-pane');
  const panel = setupPanel('Live Call', 'Phone, recorder, and call controls in one workspace.');
  const feedback = document.createElement('p');
  feedback.id = 'call-action-feedback';
  feedback.className = 'action-feedback';
  feedback.setAttribute('role', 'alert');
  feedback.setAttribute('aria-live', 'assertive');
  workspace.replaceChildren(panel);
  try {
    const [data, contactsData, callLogData] = await Promise.all([
      snapshot ?? window.gatewayDesktop.read('liveCall'),
      window.gatewayDesktop.read('contacts').catch(() => ({ rows: [] })),
      window.gatewayDesktop.read('callLog').catch(() => ({ rows: [] })),
    ]);
    if (data?.mode !== 'live') throw new Error('gateway unavailable');
    const status = data.status ?? {};
    const sourceCall = status.currentCall
      && !status.currentCall.displayNumber
      && liveCallPresentation?.number
      ? { ...status.currentCall, displayNumber: liveCallPresentation.number }
      : status.currentCall;
    const identityRows = [
      ...(contactsData?.rows ?? []),
      ...(callLogData?.rows ?? []).filter((row) => typeof row?.name === 'string' && row.name.length > 0),
    ];
    const identity = incomingCallIdentity(sourceCall, identityRows);
    const authoritativeCall = sourceCall && identity.name && !sourceCall.contactName
      ? { ...sourceCall, contactName: identity.name }
      : sourceCall;
    liveCallSnapshotKey = liveCallKey(data);
    syncIncomingRinger(authoritativeCall);
    if (authoritativeCall?.callId) {
      if (liveCallPresentation && authoritativeCall.direction === 'outgoing') liveCallPresentation.observed = true;
      if (liveCallClock?.callId !== authoritativeCall.callId) {
        liveCallClock = { callId: authoritativeCall.callId, startedAt: Date.now() };
      }
    } else {
      if (liveCallPresentation?.observed || (liveCallPresentation
        && Date.now() - liveCallPresentation.requestedAt > 30_000)) {
        liveCallPresentation = null;
      }
      liveCallClock = null;
    }
    const call = authoritativeCall ?? (liveCallPresentation ? {
      phase: 'dialing',
      direction: 'outgoing',
      displayNumber: liveCallPresentation.number,
    } : null);
    const blocked = callReadiness(status);
    const phoneReady = status.device?.connected === true
      && status.device?.authenticated === true
      && status.device?.phase === 'ready';
    const recordingReady = status.recording?.healthy === true;
    const callState = String(call?.state ?? call?.phase ?? '').toLowerCase();
    const callStateLabel = callState ? callState.replaceAll('_', ' ') : 'Idle';
    panel.querySelector('.panel-state').textContent = call
      ? `${callStateLabel} · ${blocked || 'Controls ready'}`
      : blocked || 'Ready to place a call';

    const grid = document.createElement('div');
    grid.className = 'live-call-grid';
    const readiness = setupCard('Call readiness', 'Live status from the authenticated phone and the desktop recorder.', 'agentcall');
    addStatusRow(readiness, 'Phone', phoneReady ? 'Authenticated USB' : 'Connection required', phoneReady ? 'healthy-text' : 'warning-text');
    addStatusRow(readiness, 'Desktop recorder', recordingReady ? 'Ready' : 'Needs attention', recordingReady ? 'healthy-text' : 'warning-text');
    addStatusRow(readiness, 'Current call', call ? callStateLabel : 'None', call ? 'info-text' : '');
    if (blocked) addStatusRow(readiness, 'Next step', blocked, 'warning-text');

    const dialCard = setupCard('New outbound call', 'Use the full international number, including the leading + and country code.');
    const dialForm = document.createElement('form');
    dialForm.className = 'live-dial-form';
    const destination = document.createElement('input');
    destination.type = 'tel'; destination.inputMode = 'tel'; destination.required = true;
    destination.pattern = '\\+[1-9][0-9]{5,14}'; destination.maxLength = 16;
    destination.placeholder = '+15551234567'; destination.setAttribute('aria-label', 'Destination in E.164 format');
    if (preparedOutboundCall?.number) destination.value = preparedOutboundCall.number;
    const destinationField = field('Phone number', destination);
    const dialButton = document.createElement('button');
    dialButton.type = 'submit'; dialButton.className = 'primary'; dialButton.textContent = 'Start call';
    dialButton.disabled = Boolean(blocked || call);
    dialForm.append(destinationField, dialButton);
    const notice = document.createElement('p');
    notice.className = 'live-call-notice muted';
    notice.textContent = preparedOutboundCall?.number
      ? `Prepared from ${preparedOutboundCall.name || 'the phone log'}. Review the number, then select Start call. No call starts automatically.`
      : 'You will confirm the destination before the phone dials. Emergency calls are always blocked.';
    dialCard.append(dialForm, notice);
    dialForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!destination.validity.valid) {
        feedback.className = 'action-feedback danger-text';
        feedback.textContent = 'Enter a full number such as +15551234567';
        return;
      }
      const confirmed = window.confirm(`Place and record a call to ${destination.value}? Emergency calls are blocked.`);
      if (!confirmed) { feedback.textContent = 'Call cancelled · no phone action was taken'; return; }
      dialButton.disabled = true; feedback.textContent = 'Starting call…';
      try {
        const receipt = await window.gatewayDesktop.dial(destination.value);
        if (receipt?.accepted !== true) throw new Error(receipt?.reason || 'rejected');
        liveCallPresentation = {
          number: destination.value,
          name: preparedOutboundCall?.name ?? '',
          requestedAt: Date.now(),
          observed: false,
        };
        preparedOutboundCall = null;
        feedback.className = 'action-feedback healthy-text'; feedback.textContent = 'Call request accepted · waiting for the phone';
        await renderLiveCall();
      } catch {
        feedback.className = 'action-feedback danger-text'; feedback.textContent = 'Call could not be started · the phone was not changed';
        dialButton.disabled = Boolean(blocked || call);
      }
    });

    const callCard = setupCard(call ? 'Current call' : 'Call controls', call
      ? `The phone reports this call as ${callStateLabel}. Controls update with the live phone state.`
      : 'Answer, reject, hang-up, and touch-tone controls appear when a call is active.');
    callCard.classList.add('live-current-card');
    if (call) {
      const hero = document.createElement('div');
      hero.className = `live-call-hero ${callState || 'idle'}`;
      const identity = document.createElement('div');
      identity.className = 'live-call-identity';
      const statusBadge = document.createElement('span');
      statusBadge.className = 'live-call-state';
      statusBadge.textContent = callStateLabel;
      const callName = document.createElement('strong');
      callName.textContent = liveCallPresentation?.name
        || call.contactName
        || call.caller?.name
        || call.displayName
        || (call.direction === 'incoming' ? 'Unknown caller' : 'Outbound call');
      const callNumber = document.createElement('p');
      callNumber.textContent = call.displayNumber || liveCallPresentation?.number || 'Number available on phone';
      identity.append(statusBadge, callName, callNumber);
      const elapsed = document.createElement('div');
      elapsed.className = 'live-call-elapsed';
      const elapsedValue = document.createElement('strong');
      elapsedValue.textContent = liveCallElapsed(liveCallClock?.startedAt ?? liveCallPresentation?.requestedAt ?? Date.now());
      const elapsedLabel = document.createElement('span');
      elapsedLabel.textContent = callState === 'dialing' ? 'Connecting' : 'Elapsed';
      elapsed.append(elapsedValue, elapsedLabel);
      hero.append(identity, elapsed);
      callCard.append(hero);
    }
    if (!call) {
      const empty = document.createElement('div');
      empty.className = 'live-call-empty';
      empty.append(brandMark('agentcall'));
      const emptyCopy = document.createElement('div');
      const emptyTitle = document.createElement('strong'); emptyTitle.textContent = 'No active call';
      const emptyText = document.createElement('p'); emptyText.className = 'muted'; emptyText.textContent = 'Place a call above or answer an incoming call from this screen.';
      emptyCopy.append(emptyTitle, emptyText); empty.append(emptyCopy); callCard.append(empty);
    }

    const controls = document.createElement('div');
    controls.className = 'live-controls';
    for (const [action, label] of [['answer', 'Answer'], ['reject', 'Reject'], ['hangup', 'Hang up']]) {
      const button = document.createElement('button');
      const stateAllowsAction = action === 'hangup'
        ? ['dialing', 'active', 'connected', 'answered', 'ending'].includes(callState)
        : ['ringing', 'incoming'].includes(callState);
      button.type = 'button'; button.textContent = label;
      button.className = `live-action ${action}`;
      button.hidden = action === 'hangup'
        ? call?.direction === 'incoming' && ['ringing', 'incoming'].includes(callState)
        : !(call?.direction === 'incoming' && ['ringing', 'incoming'].includes(callState));
      const safeTermination = action === 'reject' || action === 'hangup';
      const terminationBlocked = Boolean(blocked && blocked !== 'Recording health required');
      button.disabled = Boolean(
        (!safeTermination && blocked)
        || (safeTermination && terminationBlocked)
        || !authoritativeCall?.callId
        || !stateAllowsAction,
      );
      button.addEventListener('click', async () => {
        button.disabled = true; feedback.textContent = `${label} requested…`;
        try {
          const receipt = await window.gatewayDesktop.call(action, authoritativeCall.callId);
          if (receipt?.accepted !== true) throw new Error('rejected');
          feedback.className = 'action-feedback healthy-text'; feedback.textContent = `${label} request accepted`;
        } catch {
          feedback.className = 'action-feedback danger-text'; feedback.textContent = `${label} failed · the call was not changed`;
          button.disabled = false;
        }
      });
      controls.append(button);
    }
    const dtmf = document.createElement('input');
    dtmf.type = 'text'; dtmf.inputMode = 'tel'; dtmf.maxLength = 32; dtmf.pattern = '[0-9*#A-Da-d]+';
    dtmf.placeholder = '123#'; dtmf.setAttribute('aria-label', 'Touch-tone digits');
    const sendDtmf = document.createElement('button');
    sendDtmf.type = 'button'; sendDtmf.className = 'secondary'; sendDtmf.textContent = 'Send tones';
    sendDtmf.disabled = Boolean(blocked || !authoritativeCall?.callId || !['active', 'connected', 'answered'].includes(callState));
    sendDtmf.addEventListener('click', async () => {
      if (!dtmf.validity.valid || dtmf.value.length === 0) { feedback.className = 'action-feedback danger-text'; feedback.textContent = 'Touch tones can contain 0–9, *, #, or A–D'; return; }
      sendDtmf.disabled = true; feedback.textContent = 'Sending touch tones…';
      try {
        const receipt = await window.gatewayDesktop.call('dtmf', authoritativeCall.callId, dtmf.value);
        if (receipt?.accepted !== true) throw new Error('rejected');
        dtmf.value = ''; feedback.className = 'action-feedback healthy-text'; feedback.textContent = 'Touch tones sent';
      } catch { feedback.className = 'action-feedback danger-text'; feedback.textContent = 'Touch tones failed · nothing was confirmed'; }
      finally { sendDtmf.disabled = false; }
    });
    const toneRow = document.createElement('div');
    toneRow.className = 'live-tone-row';
    toneRow.append(field('Touch tones', dtmf), sendDtmf);
    if (call) {
      const audioRow = document.createElement('div');
      audioRow.className = 'live-audio-row';
      const audioCopy = document.createElement('div');
      const audioTitle = document.createElement('strong'); audioTitle.textContent = 'Computer microphone and speakers';
      const audioDetail = document.createElement('p'); audioDetail.className = 'muted';
      const audioActive = manualAudio?.callId === authoritativeCall?.callId;
      audioDetail.textContent = audioActive
        ? 'Connected to this call. Echo cancellation and noise reduction are active.'
        : 'Talk from this computer instead of using the phone speaker and microphone.';
      audioCopy.append(audioTitle, audioDetail);
      const audioButton = document.createElement('button');
      audioButton.type = 'button'; audioButton.className = audioActive ? 'secondary' : 'primary';
      audioButton.textContent = audioActive ? 'Stop PC audio' : 'Use PC audio';
      audioButton.disabled = Boolean(
        blocked || !authoritativeCall?.callId
        || !['active', 'connected', 'answered'].includes(callState),
      );
      audioButton.addEventListener('click', async () => {
        audioButton.disabled = true;
        feedback.textContent = audioActive ? 'Disconnecting computer audio…' : 'Requesting microphone access…';
        try {
          if (audioActive) await stopManualAudio(); else await startManualAudio(authoritativeCall.callId);
          feedback.className = 'action-feedback healthy-text';
          feedback.textContent = audioActive ? 'Computer audio disconnected' : 'Computer microphone and speakers are connected';
          await renderLiveCall();
        } catch {
          feedback.className = 'action-feedback danger-text';
          feedback.textContent = 'Computer audio could not start. Check microphone permission and the active call.';
          audioButton.disabled = false;
        }
      });
      audioRow.append(audioCopy, audioButton);
      callCard.append(controls, toneRow, audioRow);
    }
    grid.append(readiness, dialCard, callCard);
    panel.append(grid, feedback);
    if (call) scheduleLiveCallRefresh();
  } catch {
    liveCallSnapshotKey = '';
    stopIncomingRinger();
    panel.querySelector('.panel-state').textContent = 'UNAVAILABLE · local gatewayd live-call state is not connected';
    feedback.className = 'action-feedback danger-text'; feedback.textContent = 'Call controls unavailable · no device action was attempted'; panel.append(feedback);
  }
}

function retentionLabel(recording) {
  const value = recording.retention?.deleteAfter;
  if (!value) return 'No automatic deletion date';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `Delete after ${new Date(timestamp).toLocaleString()}` : 'Retention date unavailable';
}

function formatDuration(durationMillis) {
  const seconds = Math.max(0, Math.round(Number(durationMillis) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

async function renderRecordings() {
  const workspace = document.querySelector('.workspace-pane');
  workspace.replaceChildren();
  const panel = document.createElement('section');
  panel.className = 'route-panel recording-panel';
  const heading = document.createElement('h2');
  heading.textContent = 'Recordings';
  const state = document.createElement('p');
  state.className = 'panel-state';
  state.textContent = 'Loading finalized recordings…';
  const feedback = document.createElement('p');
  feedback.id = 'recording-action-feedback';
  feedback.className = 'action-feedback';
  feedback.setAttribute('role', 'alert');
  feedback.setAttribute('aria-live', 'assertive');
  panel.append(heading, state, feedback);
  workspace.append(panel);
  try {
    const [data, overview] = await Promise.all([
      window.gatewayDesktop.read('storage'),
      window.gatewayDesktop.read('overview'),
    ]);
    if (data?.mode !== 'live') {
      state.textContent = 'UNAVAILABLE · local gatewayd recording catalog is not connected';
      return;
    }
    const recordings = boundedFinalizedCatalog(data.recordings);
    state.textContent = recordings.length ? `${recordings.length} finalized recording${recordings.length === 1 ? '' : 's'}` : 'No calls or recordings';
    const phoneCopy = overview?.gateway?.phoneRecordingCopy;
    const syncSummary = document.createElement('p');
    syncSummary.className = `recording-sync-summary ${phoneCopy?.state === 'failed' ? 'warning-text' : 'muted'}`;
    syncSummary.textContent = phoneCopy?.state === 'stored'
      ? `Latest phone copy saved · ${phoneCopy.callId}`
      : phoneCopy?.state === 'syncing'
        ? `Copying ${phoneCopy.callId} to the phone…`
        : phoneCopy?.state === 'failed'
          ? `Latest phone copy needs attention · ${phoneCopy.reason || 'use Sync to phone to retry'}`
          : 'Finalized calls can be copied to the connected phone.';
    panel.append(syncSummary);
    for (const recording of recordings) {
      const row = document.createElement('article');
      row.className = 'recording-row';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `Call ${recording.callId}`;
      const detail = document.createElement('small');
      detail.textContent = `${recording.outcome ?? 'unknown'} · ${formatDuration(recording.durationMillis)} · integrity complete`;
      const audio = document.createElement('audio');
      audio.className = 'recording-player';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.hidden = true;
      copy.append(title, detail, audio);
      const actions = document.createElement('div');
      actions.className = 'recording-actions';
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Play';
      play.disabled = !canOpenFinalizedRecording(recording);
      play.addEventListener('click', async () => {
        if (!canOpenFinalizedRecording(recording)) return;
        play.disabled = true;
        try {
          const playback = await window.gatewayDesktop.playRecording(recording.callId);
          audio.src = playback.mediaUrl;
          audio.hidden = false;
          await audio.play();
          recordingFeedback('Playing inside AgentCall Desktop');
        } catch {
          recordingFeedback('Playback failed · the recording remains available', true);
        } finally {
          play.disabled = !canOpenFinalizedRecording(recording);
        }
      });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'secondary';
      save.textContent = 'Save a copy';
      save.disabled = !canOpenFinalizedRecording(recording);
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          const result = await window.gatewayDesktop.saveRecording(recording.callId);
          recordingFeedback(result.canceled ? 'Save canceled' : 'Recording copy saved');
        } catch {
          recordingFeedback('Save failed · the original recording is unchanged', true);
        } finally {
          save.disabled = !canOpenFinalizedRecording(recording);
        }
      });
      const sync = document.createElement('button');
      sync.type = 'button';
      sync.className = 'secondary';
      sync.textContent = 'Sync to phone';
      const canSyncToPhone = recording.artifacts?.includes('conversation.wav') === true;
      sync.disabled = !canSyncToPhone;
      sync.title = canSyncToPhone
        ? 'Copy this verified recording to the connected phone'
        : 'Phone sync is available for recordings created by this AgentCall release';
      sync.addEventListener('click', async () => {
        if (!canSyncToPhone) return;
        sync.disabled = true;
        recordingFeedback('Copying recording to the connected phone…');
        try {
          await window.gatewayDesktop.syncRecording(recording.callId);
          recordingFeedback('Recording copied to the phone');
        } catch {
          recordingFeedback('Phone sync failed · keep the phone connected and idle, then retry', true);
        } finally {
          sync.disabled = !canSyncToPhone;
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger-outline';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Permanently delete this finalized recording? This cannot be undone.')) return;
        remove.disabled = true;
        try {
          await window.gatewayDesktop.deleteRecording(recording.callId);
          await renderRecordings();
        } catch {
          recordingFeedback('Delete failed · recording remains available', true);
        } finally { remove.disabled = false; }
      });
      actions.append(play, save, sync, remove);
      row.append(copy, actions);
      panel.append(row);
    }
  } catch {
    state.textContent = 'UNAVAILABLE · local gatewayd recording catalog is not connected';
  }
}

document.querySelectorAll('.nav-button[data-route]').forEach((button) => button.addEventListener('click', () => selectRoute(button.dataset.route)));
document.addEventListener('click', (event) => { if (event.target.closest('.back-button')) location.reload(); });
document.querySelector('.search input')?.addEventListener('input', (event) => renderPhoneCallRows(event.target.value));
document.querySelector('[data-new-call]')?.addEventListener('click', () => selectRoute('live-call'));

window.addEventListener('DOMContentLoaded', async () => {
  window.gatewayDesktop?.onNavigate?.(selectRoute);
  window.gatewayDesktop?.onManualAudio?.(playManualAudio);
  window.gatewayDesktop?.onManualAudioClosed?.(({ callId }) => {
    if (manualAudio?.callId === callId) void stopManualAudio();
  });
  window.gatewayDesktop?.onGatewayEvent?.((event) => {
    if (['ended', 'error', 'media_failure'].includes(event.event) && manualAudio?.callId === event.callId) {
      void stopManualAudio();
    }
    if (['ended', 'error', 'media_failure'].includes(event.event)) {
      liveCallPresentation = null;
      liveCallClock = null;
      stopIncomingRinger();
    }
    if (document.querySelector('.app-shell')?.dataset.route === 'live-call') {
      scheduleLiveCallRefresh(120);
    }
  });
  await renderPhoneCallLog();
  await refreshRuntimeStatus();
  setInterval(() => { void refreshRuntimeStatus(); }, 5_000);
});
