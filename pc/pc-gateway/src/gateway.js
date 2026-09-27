import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';

import { AdbManager } from './adb-manager.js';
import { DeviceClient } from './device-client.js';
import { NetworkAdbManager } from './network-adb-manager.js';
import { NetworkDeviceClient } from './network-device-client.js';
import { DIR_HOST_TO_DEVICE } from './framing.js';
import { Policy, redactPhoneNumber } from './policy.js';
import { syncFinalizedRecording } from './recording-artifact-sync.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_NAMES = Object.freeze([
  'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
  'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
]);
const DEFAULT_RECORDING_SYNC_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 10_000, 30_000]);
const DEFAULT_OUTGOING_DIAL_START_TIMEOUT_MS = 15_000;

function parseJsonFrame(frame) {
  try {
    const value = JSON.parse(frame.payload.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class Gateway extends EventEmitter {
  constructor(options = {}) {
    super();
    const isNetworkMode = options.mode === 'network';
    const adbOptions = isNetworkMode ? {} : {
      adbPath: options.adbPath,
      adbHome: options.adbHome,
      serverSocket: options.adbServerSocket,
      expectedIdentity: options.expectedIdentity,
    };
    this.adb = options.adb ?? (isNetworkMode
      ? new NetworkAdbManager({
          phoneHost: options.phoneHost,
          phonePort: options.phonePort,
          expectedIdentity: options.expectedIdentity,
        })
      : new AdbManager(adbOptions));
    if (!options.device && (!Buffer.isBuffer(options.controllerSecret) || options.controllerSecret.length !== 32)) {
      throw new Error('controller secret must be exactly 32 bytes');
    }
    this.device = options.device ?? (isNetworkMode
      ? new NetworkDeviceClient({
          host: options.phoneHost,
          port: options.phonePort,
          enrollmentSecret: Buffer.from(options.controllerSecret),
        })
      : new DeviceClient({
          enrollmentSecret: Buffer.from(options.controllerSecret),
        }));
    this.hostPort = options.hostPort;
    this.phonePort = options.phonePort;
    this.idempotencySalt = options.idempotencySalt ?? 'agentcall-local';
    this.idempotencyCacheSize = options.idempotencyCacheSize ?? 256;
    this.commandResultTimeoutMs = options.commandResultTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.commandResultTimeoutMs)
        || this.commandResultTimeoutMs < 1 || this.commandResultTimeoutMs > 120_000) {
      throw new Error('command result timeout is invalid');
    }
    this.outgoingDialStartTimeoutMs = options.outgoingDialStartTimeoutMs
      ?? DEFAULT_OUTGOING_DIAL_START_TIMEOUT_MS;
    if (!Number.isInteger(this.outgoingDialStartTimeoutMs)
        || this.outgoingDialStartTimeoutMs < 1 || this.outgoingDialStartTimeoutMs > 120_000) {
      throw new Error('outgoing dial start timeout is invalid');
    }
    this.setOutgoingDialTimer = options.setOutgoingDialTimer ?? setTimeout;
    this.clearOutgoingDialTimer = options.clearOutgoingDialTimer ?? clearTimeout;
    this.policy = options.policy instanceof Policy
      ? options.policy
      : new Policy({ ...(options.policy ?? {}), redactionSalt: this.idempotencySalt });
    this.recording = options.recording ?? null;
    this.callerMemory = options.callerMemory ?? null;
    this.providerSettings = options.providerSettings ?? null;
    this.agentAnswering = options.agentAnswering ?? null;
    this.phoneData = options.phoneData ?? null;
    this.createRealtimeSession = options.createRealtimeSession ?? null;
    this.checkProviderHealth = options.checkProviderHealth ?? null;
    this.runProviderTest = options.testProviders ?? null;
    this.prewarmTts = options.prewarmSpeech ?? null;
    this.recordingHealth = options.recordingHealth ?? { healthy: false, reason: 'recording not initialized' };
    this.syncFinalizedRecording = options.syncFinalizedRecording ?? syncFinalizedRecording;
    this.recordingSyncRetryDelaysMs = options.recordingSyncRetryDelaysMs
      ?? DEFAULT_RECORDING_SYNC_RETRY_DELAYS_MS;
    if (!Array.isArray(this.recordingSyncRetryDelaysMs)
        || this.recordingSyncRetryDelaysMs.length < 1
        || this.recordingSyncRetryDelaysMs.length > 16
        || this.recordingSyncRetryDelaysMs.some((delay) => (
          !Number.isInteger(delay) || delay < 100 || delay > 300_000
        ))) {
      throw new Error('recording sync retry delays are invalid');
    }
    this.setRecordingSyncRetryTimer = options.setRecordingSyncRetryTimer ?? setTimeout;
    this.clearRecordingSyncRetryTimer = options.clearRecordingSyncRetryTimer ?? clearTimeout;
    this.runtimeIdentity = options.runtimeIdentity ?? { identity: 'HARDWARE', simulator: false };
    this.phoneRecordingSyncSupported = false;
    this.phoneRecordingCopy = { state: 'unavailable', reason: 'phone capability not negotiated' };
    this.pendingPhoneRecordingSyncs = new Map();
    this.phoneRecordingSyncRetryAttempts = new Map();
    this.phoneRecordingSyncRetryTimers = new Map();
    this.activeRecorder = null;
    this.activeRecordingCallId = null;
    this.activeRealtime = null;
    this.recordingTeardownPending = false;
    this.realtimeHealth = this.createRealtimeSession
      ? { healthy: true, reason: 'ok' }
      : { healthy: false, reason: 'realtime not initialized' };
    this.currentCall = null;
    this.recordingWork = Promise.resolve();
    this.phoneDataWork = Promise.resolve();
    this.callerMemoryWork = Promise.resolve();
    this.callContexts = new Map();
    this.state = 'stopped';
    this.forward = null;
    this.replays = new Map();
    this.pendingCommandResults = new Map();
    this.pendingOutgoingRecording = null;
    this.metrics = {
      commandsSent: 0,
      commandsDenied: 0,
      idempotencyReplays: 0,
      incoming: 0,
      events: 0,
      malformedDeviceMessages: 0,
      droppedSends: 0,
    };
    this._bindDeviceEvents();
  }

  _takePendingOutgoingRecording(expected = this.pendingOutgoingRecording) {
    if (!expected || this.pendingOutgoingRecording !== expected) return null;
    this.pendingOutgoingRecording = null;
    if (expected.timer !== null) this.clearOutgoingDialTimer(expected.timer);
    return expected;
  }

  get idempotencySize() {
    return this.replays.size;
  }

  _bindDeviceEvents() {
    this.device.on('control', (frame) => this._emitDeviceJson('incoming', frame));
    this.device.on('event', (frame) => {
      const value = parseJsonFrame(frame);
      if (!value) {
        this.metrics.malformedDeviceMessages++;
        return;
      }
      if (value.event === 'contacts_snapshot_v1' || value.event === 'call_log_snapshot_v1') {
        this.phoneDataWork = this.phoneDataWork.then(async () => {
          if (!await this.phoneData?.consume?.(value)) {
            if (process.env.AGENTCALL_DEBUG_NETWORK === '1') process.stderr.write(`phone data rejected: ${JSON.stringify(value)}\\n`);
            this.metrics.malformedDeviceMessages++;
          }
        }).catch((error) => {
          if (process.env.AGENTCALL_DEBUG_NETWORK === '1') process.stderr.write(`phone data processing failed: ${error?.stack || error}\\n`);
          this.metrics.malformedDeviceMessages++;
        });
        return;
      }
      if (value.event === 'incoming') this._queueRecording(() => this._handleIncoming(value));
      else this._handleDeviceEventValue(value);
    });
    this.device.on('state', (state) => {
      if (state !== 'connected') {
        this.phoneData?.setDisconnected?.();
        this.phoneRecordingSyncSupported = false;
        this.phoneRecordingCopy = { state: 'unavailable', reason: 'phone disconnected' };
        this._handleDeviceDisconnect();
        this._rejectPendingCommandResults(new Error('device disconnected before command result'));
      }
    });
    this.device.on('pcm', (frame) => {
      if (!this.activeRecorder) return;
      this._queueRecording(async () => {
        await this.activeRecorder.writeRemote(frame.payload);
        this.emit('monitorPcm', { callId: this.activeRecordingCallId, payload: Buffer.from(frame.payload) });
        if (this.activeRealtime?.callId === this.activeRecordingCallId) {
          try {
            await this.activeRealtime.pushRemotePcm(
              frame.payload,
              typeof frame.timestampMicros === 'bigint' ? frame.timestampMicros : BigInt(Date.now()) * 1000n,
            );
          } catch {
            this.realtimeHealth = { healthy: false, reason: 'realtime provider unavailable' };
          }
        }
      });
    });
    this.device.on('overflow', () => {
      this.metrics.droppedSends = this.device.metrics.droppedSends;
    });
  }

  _emitDeviceJson(name, frame) {
    const value = parseJsonFrame(frame);
    if (!value) {
      if (process.env.AGENTCALL_DEBUG_NETWORK === '1') {
        process.stderr.write(`malformed device JSON kind=${frame.kind} payload=${frame.payload.toString('utf8')}\\n`);
      }
      this.metrics.malformedDeviceMessages++;
      return;
    }
    this.metrics[name === 'incoming' ? 'incoming' : 'events']++;
    this.emit(name, value);
  }

  async _handleIncoming(value) {
    const { callerNumber, ...safe } = value;
    let caller = { found: false };
    let contact = null;
    if (this.callerMemory && typeof callerNumber === 'string') {
      try { caller = await this.callerMemory.resolve({ phoneNumber: callerNumber }); } catch { /* bounded unavailable context */ }
    }
    if (typeof callerNumber === 'string') {
      try { contact = await this.phoneData?.findContact?.({ number: callerNumber }) ?? null; } catch { /* mirror lookup is best effort */ }
    }
    let agentAnswering = { enabled: false, instructions: '' };
    try {
      agentAnswering = await this.agentAnsweringStatus();
    } catch { /* unavailable settings fail closed */ }
    const event = {
      ...safe,
      caller,
      agentAnswering,
      ...(typeof contact?.name === 'string' ? { contactName: contact.name } : {}),
    };
    if (typeof safe.callId === 'string' && CALL_ID_RE.test(safe.callId)
        && typeof callerNumber === 'string') {
      this.callContexts.set(safe.callId, {
        phoneNumber: callerNumber,
        callId: safe.callId,
        startedAt: new Date().toISOString(),
        direction: safe.direction ?? 'incoming',
        transcript: [],
      });
    }
    this.currentCall = {
      callId: safe.callId,
      phase: 'ringing',
      direction: safe.direction ?? 'incoming',
      ...(typeof callerNumber === 'string' ? { displayNumber: callerNumber }
        : (typeof safe.displayNumber === 'string' ? { displayNumber: safe.displayNumber } : {})),
      ...(typeof contact?.name === 'string' ? { contactName: contact.name } : {}),
      caller,
    };
    this.metrics.incoming++;
    this.emit('incoming', event);
    if (this.activeRecorder && safe.callId === this.activeRecordingCallId) {
      await this.activeRecorder.appendEvent(event);
    }
  }

  _handleDeviceEventValue(value) {
    if (value.event === 'command_result') this._handleCommandResult(value);
    if (value.event === 'media_failure') {
      if (Object.keys(value).length !== 3
          || typeof value.callId !== 'string' || !CALL_ID_RE.test(value.callId)
          || value.reason !== 'audio_bridge_failed') {
        this.metrics.malformedDeviceMessages++;
        return;
      }
      if (!this.activeRecorder || value.callId !== this.activeRecordingCallId) return;
    }
    if (value.event === 'capabilities' && Array.isArray(value.values)) {
      this.phoneRecordingSyncSupported = value.values.includes('recording_sync_v1');
      this.phoneRecordingCopy = this.phoneRecordingSyncSupported
        ? { state: 'ready', reason: 'recording_sync_v1 negotiated' }
        : { state: 'unavailable', reason: 'phone capability not negotiated' };
      this.phoneData?.setCapabilities?.(value.values);
      for (const request of this.phoneData?.syncRequests?.() ?? []) {
        this.phoneDataWork = this.phoneDataWork.then(() => this._sendControl(request))
          .catch(() => { this.metrics.malformedDeviceMessages++; });
      }
      if (this.phoneRecordingSyncSupported && this.pendingPhoneRecordingSyncs.size > 0) {
        this.recordingWork = this.recordingWork
          .then(() => this._retryPendingRecordingSyncs())
          .catch(() => {});
      }
    }
    const terminal = value.event === 'ended' || value.event === 'error' || value.event === 'media_failure';
    if (terminal && typeof value.callId === 'string') this._archiveCallerContext(value);
    if (typeof value.callId === 'string') {
      if (terminal && this.currentCall?.callId === value.callId) this.currentCall = null;
      else if (value.event === 'active' || value.event === 'dialing' || value.event === 'ending') {
        const previous = this.currentCall?.callId === value.callId ? this.currentCall : { callId: value.callId };
        this.currentCall = {
          ...previous,
          phase: value.event,
          ...(typeof value.direction === 'string' ? { direction: value.direction } : {}),
        };
      }
    }
    if ((value.event === 'dialing' || value.event === 'active')
        && value.direction === 'outgoing'
        && typeof value.callId === 'string' && CALL_ID_RE.test(value.callId)
        && this.pendingOutgoingRecording) {
      const pending = this._takePendingOutgoingRecording();
      if (this.currentCall?.callId === value.callId) {
        this.currentCall = {
          ...this.currentCall,
          displayNumber: pending.displayNumber,
        };
      }
      this.callContexts.set(value.callId, {
        phoneNumber: pending.displayNumber,
        callId: value.callId,
        startedAt: new Date().toISOString(),
        direction: 'outgoing',
        transcript: [],
      });
      this.recordingWork = this.recordingWork.then(async () => {
        try {
          const contact = await this.phoneData?.findContact?.({ number: pending.displayNumber }) ?? null;
          if (this.currentCall?.callId === value.callId && typeof contact?.name === 'string') {
            this.currentCall = { ...this.currentCall, contactName: contact.name };
          }
          await this.beginRecording({
            callId: value.callId,
            consent: pending.consent,
            sessionId: pending.sessionId,
            provider: pending.provider,
          });
        } catch {
          try {
            await this._sendControl({
              command: 'hangup', callId: value.callId,
              idempotencyKey: `${pending.idempotencyKey}-startup-failed`,
            });
          } catch {}
        }
      });
    }
    this.metrics.events++;
    this.emit('event', value);
    const activeRecorder = this.activeRecorder;
    if (!activeRecorder || value.callId !== this.activeRecordingCallId) return;
    this._queueRecording(async () => {
      await activeRecorder.appendEvent(value);
      if (terminal) {
        const recorder = activeRecorder;
        const realtime = this.activeRealtime;
        this.activeRealtime = null;
        this.activeRecorder = null;
        this.activeRecordingCallId = null;
        try {
          await this._sendRecordingSession(value.callId, false);
        } catch {
          this.recordingHealth = { healthy: false, reason: 'recording session acknowledgement failed' };
        }
        if (realtime?.callId === value.callId) {
          try { await realtime.close(); } catch {
            this.realtimeHealth = { healthy: false, reason: 'realtime close failed' };
          }
        }
        const finalized = await recorder.finalize({ outcome: value.event });
        const olderPendingRecording = [...this.pendingPhoneRecordingSyncs.keys()]
          .some((callId) => callId !== value.callId);
        if (finalized.complete) {
          this.pendingPhoneRecordingSyncs.set(value.callId, finalized.directory);
          if (this.phoneRecordingSyncSupported) {
            try {
              await this._syncRecordingDirectory(finalized.directory, value.callId);
            } catch {}
          } else {
            this.phoneRecordingCopy = {
              state: 'pending',
              callId: value.callId,
              reason: 'waiting for phone connection',
            };
          }
        }
        if (olderPendingRecording
            && this.phoneRecordingSyncSupported
            && this.phoneRecordingCopy.state === 'stored') {
          await this._retryPendingRecordingSyncs();
        }
      }
    });
  }

  _queueRecording(operation) {
    const ownership = this.activeRecorder && this.activeRecordingCallId
      ? {
          recorder: this.activeRecorder,
          callId: this.activeRecordingCallId,
          realtime: this.activeRealtime,
        }
      : null;
    this.recordingWork = this.recordingWork
      .then(async () => {
        if (ownership && (this.activeRecorder !== ownership.recorder
          || this.activeRecordingCallId !== ownership.callId)) return;
        await operation();
      })
      .catch(() => this._failActiveRecording(ownership));
    return this.recordingWork;
  }

  async _failActiveRecording(ownership) {
    this.recordingHealth = { healthy: false, reason: 'recording write failed' };
    if (!ownership || this.activeRecorder !== ownership.recorder
        || this.activeRecordingCallId !== ownership.callId) return;

    this.recordingTeardownPending = true;
    const realtime = this.activeRealtime?.callId === ownership.callId
      ? this.activeRealtime
      : ownership.realtime;
    this.activeRecorder = null;
    this.activeRecordingCallId = null;
    this.activeRealtime = null;
    if (this.currentCall?.callId === ownership.callId) {
      this.currentCall = { ...this.currentCall, mediaState: 'failed' };
    }

    let revocationFailed = false;
    try { await this._sendRecordingSession(ownership.callId, false); } catch { revocationFailed = true; }
    try { await this._sendControl({ command: 'recording_health', healthy: false }); } catch { revocationFailed = true; }
    if (revocationFailed) {
      try { await this.device.disconnect(); } catch {}
    }
    if (realtime?.callId === ownership.callId) {
      try { await realtime.close(); } catch {
        this.realtimeHealth = { healthy: false, reason: 'realtime close failed' };
      }
    }
    try {
      await ownership.recorder.appendEvent?.({
        event: 'recording_failed', callId: ownership.callId, reason: 'recording_write_failed',
      });
    } catch { /* finalization remains mandatory */ }
    try {
      await ownership.recorder.finalize({ outcome: 'recording_write_failed' });
    } catch { /* unhealthy status above remains authoritative */ }
    finally { this.recordingTeardownPending = false; }
  }

  _handleDeviceDisconnect() {
    const callId = this.activeRecordingCallId;
    const recorder = this.activeRecorder;
    const realtime = this.activeRealtime;
    this._takePendingOutgoingRecording();
    this.currentCall = null;
    if (!recorder || !callId || this.recordingTeardownPending) return;
    this.recordingTeardownPending = true;
    this._queueRecording(async () => {
      this.activeRealtime = null;
      this.activeRecorder = null;
      this.activeRecordingCallId = null;
      try {
        await recorder.appendEvent?.({ event: 'transport_lost', callId, reason: 'device_disconnected' });
        if (realtime?.callId === callId) {
          try { await realtime.close(); } catch {
            this.realtimeHealth = { healthy: false, reason: 'realtime close failed' };
          }
        }
        await recorder.finalize({ outcome: 'transport_lost' });
      } finally {
        this.recordingTeardownPending = false;
      }
    });
  }

  async beginRecording({ callId, consent, sessionId = null, provider = null } = {}) {
    if (!this.recording?.start) throw new Error('recording manager unavailable');
    if (consent?.recorded !== true) throw new Error('recording consent is required');
    if (this.activeRecorder || this.activeRecordingCallId || this.recordingTeardownPending) {
      throw new Error('a recording is already active');
    }
    this.activeRecordingCallId = callId;
    let recorder;
    try {
      recorder = await this.recording.start({ callId, consent, sessionId, provider });
      if (!recorder?.ready) throw new Error('recorder did not become ready');
    } catch (error) {
      if (!this.activeRecorder && this.activeRecordingCallId === callId) this.activeRecordingCallId = null;
      throw error;
    }
    this.activeRecorder = recorder;
    if (this.createRealtimeSession) {
      try {
        const realtime = await this.createRealtimeSession({ callId, gateway: this, provider });
        if (this.activeRecorder !== recorder || this.activeRecordingCallId !== callId) {
          try { await realtime?.close?.(); } catch {}
          throw new Error('recording is inactive');
        }
        await this.attachRealtime(realtime);
      } catch (error) {
        if (this.activeRecorder !== recorder || this.activeRecordingCallId !== callId) throw error;
        this.activeRealtime = null;
        this.activeRecorder = null;
        this.activeRecordingCallId = null;
        this.realtimeHealth = { healthy: false, reason: 'realtime start failed' };
        await recorder.finalize({ outcome: 'realtime_start_failed' });
        throw error;
      }
    }
    try {
      await this._sendRecordingSession(callId, true);
      if (this.activeRecorder !== recorder || this.activeRecordingCallId !== callId) {
        throw new Error('recording is inactive');
      }
    } catch (error) {
      if (this.activeRecorder !== recorder || this.activeRecordingCallId !== callId) throw error;
      const realtime = this.activeRealtime;
      this.activeRealtime = null;
      this.activeRecorder = null;
      this.activeRecordingCallId = null;
      if (realtime) {
        try { await realtime.close(); } catch {
          this.realtimeHealth = { healthy: false, reason: 'realtime close failed' };
        }
      }
      await recorder.finalize({ outcome: 'session_ack_failed' });
      throw error;
    }
    return { ready: true, callId };
  }

  async sendAgentPcm(payload) {
    if (!this.activeRecorder) throw new Error('active recorder is required');
    await this._queueRecording(() => this.activeRecorder.writeAgent(payload));
    if (!this.activeRecorder) throw new Error('recording write failed');
    await this.device.sendPcm({ direction: DIR_HOST_TO_DEVICE, payload });
  }

  async appendTranscript(value) {
    if (!this.activeRecorder) throw new Error('active recorder is required');
    await this._queueRecording(() => this.activeRecorder.appendTranscript(value));
    if (!this.activeRecorder) throw new Error('recording write failed');
    if ((value?.speaker === 'remote' || value?.speaker === 'agent') && value.final === true
        && value.callId === this.activeRecordingCallId
        && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 4_000) {
      const callContext = this.callContexts.get(value.callId);
      if (callContext) {
        callContext.transcript.push(`${value.speaker}: ${value.text}`);
        while (callContext.transcript.join('\n').length > 4_000 && callContext.transcript.length > 1) {
          callContext.transcript.shift();
        }
      }
      this.emit('event', {
        event: 'transcript_final', callId: value.callId, speaker: value.speaker,
        text: value.text, complete: value.complete === true,
        ...(typeof value.language === 'string' ? { language: value.language } : {}),
      });
    }
  }

  manualAudioAvailable({ callId } = {}) {
    return Boolean(CALL_ID_RE.test(callId ?? '')
      && this.activeRecorder && this.activeRecordingCallId === callId
      && this.currentCall?.callId === callId);
  }

  async sendManualPcm({ callId, payload } = {}) {
    if (!this.manualAudioAvailable({ callId })) throw new Error('manual audio unavailable');
    if (!Buffer.isBuffer(payload) || payload.length !== 640) {
      throw new Error('manual PCM frame must be exactly 640 bytes');
    }
    await this.sendAgentPcm(payload);
    return { accepted: true, callId };
  }

  _archiveCallerContext(value) {
    const context = this.callContexts.get(value.callId);
    if (!context) return;
    this.callContexts.delete(value.callId);
    if (!this.callerMemory?.appendCall) return;
    const transcript = context.transcript.join('\n').slice(-4_000);
    const call = {
      callId: context.callId,
      startedAt: context.startedAt,
      endedAt: new Date().toISOString(),
      direction: context.direction,
      outcome: value.event,
      transcript,
      recordingId: context.callId,
    };
    this.callerMemoryWork = this.callerMemoryWork.catch(() => {}).then(() => this.callerMemory.appendCall({
      phoneNumber: context.phoneNumber,
      call,
    })).catch(() => {});
  }

  async attachRealtime(session) {
    if (!this.activeRecorder || !this.activeRecordingCallId) throw new Error('active recorder is required');
    if (!session || session.callId !== this.activeRecordingCallId) {
      throw new Error('realtime callId must match active recording');
    }
    if (this.activeRealtime) throw new Error('a realtime session is already active');
    if (session.start) await session.start();
    if (!this.activeRecorder || session.callId !== this.activeRecordingCallId) {
      try { await session.close?.(); } catch {}
      throw new Error('recording is inactive');
    }
    this.activeRealtime = session;
    this.realtimeHealth = { healthy: true, reason: 'ok' };
  }

  async flushRecording() {
    await this.recordingWork;
  }

  async flushPhoneData() {
    await this.phoneDataWork;
  }

  async _sendRecordingSession(callId, active) {
    await this._sendControl({ command: 'recording_session', callId, active });
  }

  async start({ phoneHost = '127.0.0.1', phonePort, serial, simulator = false, existingForward = null } = {}) {
    if (this.state !== 'stopped') throw new Error(`gateway already ${this.state}`);
    const isNetworkMode = this.adb instanceof NetworkAdbManager;
    if (!isNetworkMode && !LOOPBACK_HOSTS.has(phoneHost)) throw new Error('refused non-loopback phone host');
    this.state = 'connecting';
    try {
      if (!simulator) {
        if (isNetworkMode) {
          // Network mode: no ADB forwarding needed. Device connects directly.
          this.forward = { serial: 'NETWORK', hostPort: phonePort, phonePort };
        } else if (existingForward) {
          this.forward = existingForward;
        } else {
          const selected = serial
            ? await this.adb.selectBySerial(serial)
            : (this.adb.selectOne ? await this.adb.selectOne() : (await this.adb.listDevices())[0]);
          if (this.adb.verifyIdentity) await this.adb.verifyIdentity(selected.serial);
          this.forward = await this.adb.forward({ serial: selected.serial, hostPort: this.hostPort, phonePort: phonePort ?? this.phonePort });
        }
      }
      if (this.recording?.health) this.recordingHealth = await this.recording.health();
      if (this.device.state !== 'connected') {
        await this.device.connect({
          host: isNetworkMode ? phoneHost : '127.0.0.1',
          port: simulator ? phonePort : isNetworkMode ? phonePort : this.hostPort,
        });
      }
      await this.device.sendControl({
        direction: DIR_HOST_TO_DEVICE,
        payload: Buffer.from(JSON.stringify({ command: 'capabilities' }), 'utf8'),
      });
      await this.device.sendControl({
        direction: DIR_HOST_TO_DEVICE,
        payload: Buffer.from(JSON.stringify({
          command: 'recording_health',
          healthy: this.recordingHealth.healthy,
        }), 'utf8'),
      });
      this.state = 'running';
    } catch (error) {
      try { await this.device.disconnect(); } catch {}
      try {
        if (this.forward && this.adb.killForward) {
          await this.adb.killForward({ serial: this.forward.serial, hostPort: this.forward.hostPort });
        }
      } catch {}
      this.forward = null;
      this.state = 'stopped';
      throw error;
    }
  }

  status() {
    const isNetworkMode = this.adb instanceof NetworkAdbManager;
    const authenticated = this.device?.state === 'connected';
    const simulator = this.runtimeIdentity.simulator === true;
    const connected = this.state === 'running' && authenticated && (simulator || this.forward !== null);
    const phase = simulator && connected
      ? 'simulator'
      : (connected ? 'ready' : (this.state === 'connecting' ? 'authorizing' : 'disconnected'));
    return {
      ...this.runtimeIdentity,
      state: this.state,
      device: {
        connected,
        authenticated,
        transport: simulator ? 'simulator' : isNetworkMode ? 'network' : 'usb',
        phase,
      },
      recording: { ...this.recordingHealth, active: this.activeRecorder !== null },
      phoneRecordingCopy: { ...this.phoneRecordingCopy },
      realtime: { ...this.realtimeHealth, active: this.activeRealtime !== null },
      currentCall: this.currentCall ? structuredClone(this.currentCall) : null,
      metrics: { ...this.metrics },
    };
  }

  capabilities() {
    return {
      ...this.runtimeIdentity,
      tools: [...TOOL_NAMES],
      transport: 'stdio',
      protocolVersion: '2024-11-05',
      framing: { kinds: ['CONTROL', 'EVENT'], directions: ['HOST_TO_DEVICE', 'DEVICE_TO_HOST'] },
      policy: {
        dialEnabled: this.policy.options.dialEnabled,
        manualApprovalRequired: this.policy.options.requireManualApproval,
        maxCallDurationMs: this.policy.options.maxCallDurationMs,
      },
    };
  }

  listRecordings(args) {
    if (!this.recording?.list) throw new Error('recording manager unavailable');
    return this.recording.list(args);
  }

  listContacts(args) {
    if (!this.phoneData?.listContacts) throw new Error('phone data unavailable');
    return this.phoneData.listContacts(args);
  }

  listCallLog(args) {
    if (!this.phoneData?.listCallLog) throw new Error('phone data unavailable');
    return this.phoneData.listCallLog(args);
  }

  phoneDataStatus() {
    if (!this.phoneData?.publicStatus) throw new Error('phone data unavailable');
    return this.phoneData.publicStatus();
  }

  recordingArtifact(args) {
    if (!this.recording?.artifact) throw new Error('recording manager unavailable');
    return this.recording.artifact(args);
  }

  exportRecordingArtifact(args) {
    if (!this.recording?.exportArtifact) throw new Error('recording export unavailable');
    return this.recording.exportArtifact(args);
  }

  async _syncRecordingDirectory(directory, callId) {
    this.pendingPhoneRecordingSyncs.set(callId, directory);
    this.phoneRecordingCopy = { state: 'syncing', callId };
    try {
      const stored = await this.syncFinalizedRecording({
        device: this.device, directory, callId,
      });
      this.phoneRecordingCopy = { state: 'stored', callId, bytes: stored.bytes };
      this.pendingPhoneRecordingSyncs.delete(callId);
      this._clearRecordingSyncRetry(callId);
      return this.phoneRecordingCopy;
    } catch (error) {
      const reason = typeof error?.message === 'string'
        ? error.message.slice(0, 120)
        : 'phone copy failed';
      this.phoneRecordingCopy = { state: 'failed', callId, reason };
      this._scheduleRecordingSyncRetry(callId);
      throw error;
    }
  }

  _clearRecordingSyncRetry(callId) {
    const timer = this.phoneRecordingSyncRetryTimers.get(callId);
    if (timer !== undefined) this.clearRecordingSyncRetryTimer(timer);
    this.phoneRecordingSyncRetryTimers.delete(callId);
    this.phoneRecordingSyncRetryAttempts.delete(callId);
  }

  _scheduleRecordingSyncRetry(callId) {
    if (!this.pendingPhoneRecordingSyncs.has(callId)
        || this.phoneRecordingSyncRetryTimers.has(callId)
        || this.state === 'stopped') return;
    const attempt = this.phoneRecordingSyncRetryAttempts.get(callId) ?? 0;
    const delay = this.recordingSyncRetryDelaysMs[
      Math.min(attempt, this.recordingSyncRetryDelaysMs.length - 1)
    ];
    this.phoneRecordingSyncRetryAttempts.set(callId, attempt + 1);
    const timer = this.setRecordingSyncRetryTimer(() => {
      this.phoneRecordingSyncRetryTimers.delete(callId);
      if (!this.pendingPhoneRecordingSyncs.has(callId) || this.state === 'stopped') return;
      if (this.currentCall) {
        this._scheduleRecordingSyncRetry(callId);
        return;
      }
      if (!this.phoneRecordingSyncSupported || this.device.state !== 'connected') return;
      const directory = this.pendingPhoneRecordingSyncs.get(callId);
      this.recordingWork = this.recordingWork
        .then(() => this._syncRecordingDirectory(directory, callId))
        .catch(() => {});
    }, delay);
    timer?.unref?.();
    this.phoneRecordingSyncRetryTimers.set(callId, timer);
  }

  async _retryPendingRecordingSyncs() {
    for (const [callId, directory] of [...this.pendingPhoneRecordingSyncs]) {
      if (!this.phoneRecordingSyncSupported || this.device.state !== 'connected') return;
      try {
        await this._syncRecordingDirectory(directory, callId);
      } catch {
        // Keep the finalized directory queued. A later capability handshake or
        // explicit retry will make another idempotent transfer attempt.
      }
    }
  }

  async syncRecording({ callId } = {}) {
    if (!CALL_ID_RE.test(callId ?? '')) throw new Error('invalid callId');
    if (!this.phoneRecordingSyncSupported || this.device?.state !== 'connected') {
      throw new Error('phone recording sync unavailable');
    }
    if (this.currentCall) throw new Error('recording sync waits until the call is idle');
    const artifact = await this.recordingArtifact({ callId, artifact: 'conversation.wav' });
    const operation = this.recordingWork.then(() => this._syncRecordingDirectory(dirname(artifact), callId));
    this.recordingWork = operation.catch(() => {});
    return operation;
  }

  deleteRecording(args) {
    if (!this.recording?.delete) throw new Error('recording manager unavailable');
    return this.recording.delete(args);
  }

  providerStatus() {
    if (!this.providerSettings?.publicStatus) throw new Error('provider settings unavailable');
    return this.providerSettings.publicStatus();
  }

  configureProvider(args) {
    if (!this.providerSettings?.configure) throw new Error('provider settings unavailable');
    return this.providerSettings.configure(args);
  }

  agentAnsweringStatus() {
    if (!this.agentAnswering?.status) {
      return Promise.resolve({ enabled: false, instructions: '' });
    }
    return this.agentAnswering.status();
  }

  configureAgentAnswering(args) {
    if (!this.agentAnswering?.configure) throw new Error('agent answering settings unavailable');
    return this.agentAnswering.configure(args);
  }

  async providerHealth(args) {
    if (typeof this.checkProviderHealth !== 'function') throw new Error('realtime is inactive');
    return this.checkProviderHealth(args);
  }

  async testProviders() {
    if (typeof this.runProviderTest !== 'function') throw new Error('realtime is inactive');
    return this.runProviderTest();
  }

  async prewarmSpeech({ text } = {}) {
    if (typeof this.prewarmTts !== 'function') throw new Error('realtime is inactive');
    await this.prewarmTts({ text });
    return { ready: true };
  }

  dial({ destination, idempotencyKey, approved = false, consent } = {}) {
    return this._idempotent('dial', idempotencyKey, { destination, approved, consent }, async () => {
      if (!this.recordingHealth.healthy) return this._recordingDenied();
      if (consent?.recorded !== true || typeof consent.policy !== 'string'
          || consent.policy.length < 1 || consent.policy.length > 256) {
        this.metrics.commandsDenied++;
        return { accepted: false, reason: 'recording unavailable' };
      }
      if (this.pendingOutgoingRecording || this.activeRecorder || this.recordingTeardownPending) {
        this.metrics.commandsDenied++;
        return { accepted: false, reason: 'recording unavailable' };
      }
      const policyDecision = this.policy.decideDial({ destination, approved });
      if (!policyDecision.allow) {
        this.metrics.commandsDenied++;
        return { accepted: false, reason: policyDecision.reason, destination: policyDecision.destination };
      }
      const pending = {
        consent: structuredClone(consent), idempotencyKey,
        sessionId: `outgoing-${idempotencyKey}`, provider: 'realtime',
        displayNumber: destination,
        timer: null,
      };
      this.pendingOutgoingRecording = pending;
      pending.timer = this.setOutgoingDialTimer(() => {
        this._takePendingOutgoingRecording(pending);
      }, this.outgoingDialStartTimeoutMs);
      pending.timer?.unref?.();
      try {
        await this._sendControl({ command: 'dial', destination, idempotencyKey });
      } catch (error) {
        this._takePendingOutgoingRecording(pending);
        throw error;
      }
      return { accepted: true, destination: redactPhoneNumber(destination, this.idempotencySalt) };
    });
  }

  answer({ callId, idempotencyKey }) {
    return this._idempotent('answer', idempotencyKey, { callId }, async () => {
      if (!this.recordingHealth.healthy) return this._recordingDenied(callId);
      if (this.currentCall?.callId === callId && this.currentCall.direction === 'incoming' && !this.activeRecorder) {
        try {
          await this.beginRecording({
            callId,
            consent: { recorded: true, policy: 'desktop answer requires recording' },
            sessionId: `incoming-${callId}`,
            provider: 'realtime',
          });
        } catch {
          return this._recordingDenied(callId);
        }
      }
      if (this.activeRecorder && this.activeRecordingCallId !== callId) return this._recordingDenied(callId);
      await this._sendControl({ command: 'answer', callId, idempotencyKey });
      return { accepted: true, callId };
    });
  }

  providerCatalog(args) {
    if (!this.providerSettings?.catalog) throw new Error('provider catalog unavailable');
    return this.providerSettings.catalog(args);
  }

  reject({ callId, idempotencyKey }) {
    return this._command('reject', { callId }, idempotencyKey);
  }

  hangup({ callId, idempotencyKey }) {
    return this._command('hangup', { callId }, idempotencyKey);
  }

  sendDtmf({ callId, digits, idempotencyKey }) {
    if (!this.recordingHealth.healthy) return this._idempotent('send_dtmf', idempotencyKey, { callId, digits }, async () => this._recordingDenied(callId));
    return this._command('send_dtmf', { callId, digits }, idempotencyKey);
  }

  speak({ callId, text, interruptible = true, idempotencyKey }) {
    const speechRequest = interruptible === false ? { text, interruptible: false } : { text };
    return this._idempotent('speak', idempotencyKey, {
      callId, text, ...(interruptible === false ? { interruptible: false } : {}),
    }, async () => {
      if (!this.activeRecorder || !this.activeRealtime || this.activeRecordingCallId !== callId
          || this.activeRealtime.callId !== callId) {
        this.metrics.commandsDenied++;
        return { accepted: false, callId, reason: 'realtime unavailable' };
      }
      let speech;
      try {
        speech = await this.activeRealtime.speak(speechRequest);
      } catch {
        this.metrics.commandsDenied++;
        return { accepted: false, callId, reason: 'speech provider unavailable' };
      }
      await this.appendTranscript({
        speaker: 'agent', text, final: true, complete: speech?.interrupted !== true, callId,
      });
      return { accepted: true, callId, interrupted: speech?.interrupted === true };
    });
  }

  _recordingDenied(callId) {
    this.metrics.commandsDenied++;
    return callId
      ? { accepted: false, callId, reason: 'recording unavailable' }
      : { accepted: false, reason: 'recording unavailable' };
  }

  _command(command, fields, idempotencyKey) {
    return this._idempotent(command, idempotencyKey, fields, async () => {
      await this._sendControl({ command, ...fields, idempotencyKey });
      return { accepted: true, callId: fields.callId };
    });
  }

  provisionDeviceEvidence(fields) {
    const { idempotencyKey } = fields;
    return this._idempotent('provision_device_evidence', idempotencyKey, fields, async () => {
      return this._sendAndAwaitCommandResult({ command: 'provision_device_evidence', ...fields });
    });
  }

  async _sendAndAwaitCommandResult(value) {
    const { idempotencyKey, command } = value;
    if (this.pendingCommandResults.has(idempotencyKey)) throw new Error('command result key already pending');
    let timer;
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pendingCommandResults.delete(idempotencyKey);
        reject(new Error('device command result timed out'));
      }, this.commandResultTimeoutMs);
      this.pendingCommandResults.set(idempotencyKey, { command, resolve, reject, timer });
    });
    const send = this._sendControl(value).catch((error) => {
      const pending = this.pendingCommandResults.get(idempotencyKey);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommandResults.delete(idempotencyKey);
      }
      throw error;
    });
    return Promise.race([
      result,
      send.then(() => result),
    ]);
  }

  _handleCommandResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.event !== 'command_result'
        || typeof value.idempotencyKey !== 'string' || !CALL_ID_RE.test(value.idempotencyKey)
        || typeof value.command !== 'string' || typeof value.accepted !== 'boolean') return;
    const expectedKeys = value.accepted
      ? ['accepted', 'command', 'event', 'idempotencyKey']
      : ['accepted', 'command', 'event', 'idempotencyKey', 'reason'];
    if (Object.keys(value).length !== expectedKeys.length
        || !expectedKeys.every((key) => Object.hasOwn(value, key))
        || (!value.accepted && (typeof value.reason !== 'string' || value.reason.length < 1
          || value.reason.length > 160 || /[\u0000-\u001f\u007f]/.test(value.reason)))) return;
    const pending = this.pendingCommandResults.get(value.idempotencyKey);
    if (!pending || value.command !== pending.command) return;
    clearTimeout(pending.timer);
    this.pendingCommandResults.delete(value.idempotencyKey);
    if (value.accepted) pending.resolve({ accepted: true });
    else pending.reject(new Error(value.reason));
  }

  _rejectPendingCommandResults(error) {
    for (const pending of this.pendingCommandResults.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommandResults.clear();
  }

  async _sendControl(value) {
    if (this.state !== 'running') throw new Error('gateway not running');
    await this.device.sendControl({
      direction: DIR_HOST_TO_DEVICE,
      payload: Buffer.from(JSON.stringify(value), 'utf8'),
    });
    this.metrics.commandsSent++;
  }

  async _idempotent(operation, idempotencyKey, fields, run) {
    const cacheKey = createHash('sha256').update(`${this.idempotencySalt}:${idempotencyKey}`).digest('hex');
    const fingerprint = createHash('sha256').update(canonicalJson({ operation, fields })).digest('hex');
    const existing = this.replays.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('idempotency key collision');
      this.metrics.idempotencyReplays++;
      return existing.promise;
    }
    const entry = { fingerprint, pending: true, promise: Promise.resolve().then(run) };
    this.replays.set(cacheKey, entry);
    try {
      const result = await entry.promise;
      entry.pending = false;
      let completed = [...this.replays.values()].filter((candidate) => !candidate.pending).length;
      for (const [key, candidate] of this.replays) {
        if (completed <= this.idempotencyCacheSize) break;
        if (!candidate.pending) {
          this.replays.delete(key);
          completed--;
        }
      }
      return result;
    } catch (error) {
      if (this.replays.get(cacheKey) === entry) this.replays.delete(cacheKey);
      throw error;
    }
  }

  async stop() {
    if (this.state === 'stopped') return;
    try {
      await this.recordingWork;
      await this.phoneDataWork;
      this._takePendingOutgoingRecording();
      this.currentCall = null;
      if (this.activeRecorder) {
        const recorder = this.activeRecorder;
        const realtime = this.activeRealtime;
        const callId = this.activeRecordingCallId;
        if (callId) {
          try { await this._sendRecordingSession(callId, false); } catch {}
        }
        this.activeRealtime = null;
        this.activeRecorder = null;
        this.activeRecordingCallId = null;
        if (callId) {
          try {
            await recorder.appendEvent?.({ event: 'gateway_stopped', callId, reason: 'gateway_shutdown' });
          } catch {
            this.recordingHealth = { healthy: false, reason: 'recording shutdown event failed' };
          }
        }
        if (realtime) {
          try { await realtime.close(); } catch {
            this.realtimeHealth = { healthy: false, reason: 'realtime close failed' };
          }
        }
        try {
          await recorder.finalize({ outcome: 'gateway_stopped' });
        } catch {
          this.recordingHealth = { healthy: false, reason: 'recording finalization failed' };
        }
      }
      this.state = 'stopped';
      await this.device.disconnect();
    } finally {
      for (const callId of [...this.phoneRecordingSyncRetryTimers.keys()]) {
        this._clearRecordingSyncRetry(callId);
      }
      this._rejectPendingCommandResults(new Error('gateway stopped before command result'));
      this.replays.clear();
      if (this.forward && this.adb.killForward) {
        await this.adb.killForward({ serial: this.forward.serial, hostPort: this.forward.hostPort });
      }
      this.forward = null;
    }
  }
}

export default Gateway;
