#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdbManager } from './adb-manager.js';
import { AgentAnsweringSettingsStore, agentAnsweringPathFromEnv } from './agent-answering-settings.js';
import { BootstrapClient } from './bootstrap-client.js';
import { BootstrapTransport } from './bootstrap-transport.js';
import { ControllerCredentialStore } from './controller-credential-store.js';
import { DeviceClient } from './device-client.js';
import { NetworkAdbManager } from './network-adb-manager.js';
import { NetworkBootstrapTransport } from './network-bootstrap-transport.js';
import { NetworkDeviceClient } from './network-device-client.js';
import { Gateway } from './gateway.js';
import { CallerMemoryStore } from './caller-memory.js';
import { loadControllerSecret as readControllerSecret } from './controller-secret.js';
import { GatewayRpcServer } from './gateway-rpc.js';
import { PhoneSimulator } from './phone-simulator.js';
import { PhoneDataStore } from './phone-data-sync.js';
import { ProviderSettingsStore, providerSettingsPathFromEnv } from './provider-settings.js';
import { loadMatchedArtifactManifest as readMatchedArtifact } from './matched-artifact.js';
import {
  loadOrCreateRedactionSalt as readOrCreateRedactionSalt,
  loadRedactionSalt as readRedactionSalt,
} from './redaction-salt.js';
import { RecordingManager } from './recording.js';
import { createRealtimeFactory } from './realtime-runtime.js';
import { createRealtimeRegistry as buildRealtimeRegistry } from './realtime-registry.js';
import { configFromEnv, rpcSocketFromEnv } from './runtime-config.js';

const LOCAL_TOOLS = Object.freeze([
  'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
  'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
]);

const APPROVED_GRAM_VENDOR_FINGERPRINT =
  'POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys';

function localIsoDate(now) {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function deviceEvidenceProvisioningArgs(selected, now = new Date()) {
  const identity = selected?.identity;
  if (!identity || !(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
  const supported = identity.product === 'lineage_miatoll'
    && identity.device === 'gram'
    && identity.model === 'POCO M2 Pro'
    && String(identity.api) === '35'
    && typeof identity.fingerprint === 'string'
    && identity.fingerprint.length > 0
    && identity.fingerprint.length <= 1_024
    && identity.vendorFingerprint === APPROVED_GRAM_VENDOR_FINGERPRINT;
  if (!supported) return null;
  const attestedOn = localIsoDate(now);
  const digest = createHash('sha256')
    .update(`${selected.serial}\0${identity.fingerprint}\0${identity.vendorFingerprint}\0${attestedOn}`)
    .digest('hex')
    .slice(0, 32);
  return {
    observedSystemFingerprint: identity.fingerprint,
    observedVendorFingerprint: identity.vendorFingerprint,
    attestedOn,
    attestedSystemDescription: `${identity.model} ${identity.device}, Android API ${identity.api}, authenticated matched-device identity`,
    idempotencyKey: `matched-device-evidence-${digest}`,
  };
}

export class LocalControlPlane extends EventEmitter {
  constructor({
    recording = null,
    providerSettings = null,
    agentAnswering = null,
    phoneData = null,
    checkProviderHealth = null,
    testProviders = null,
    prewarmSpeech = null,
  } = {}) {
    super();
    this.delegate = null;
    this.recording = recording;
    this.providerSettings = providerSettings;
    this.agentAnswering = agentAnswering;
    this.phoneData = phoneData;
    this.checkProviderHealth = checkProviderHealth;
    this.runProviderTest = testProviders;
    this.prewarmTts = prewarmSpeech;
    this.setup = { stage: 'WAITING_FOR_PHONE', reasonCode: 'phone_not_connected' };
    this._forwardIncoming = (value) => this.emit('incoming', value);
    this._forwardEvent = (value) => this.emit('event', value);
    this._forwardMonitorPcm = (value) => this.emit('monitorPcm', value);
  }

  setStage(stage, reasonCode = null) {
    this.setup = { stage, reasonCode };
    this.emit('event', { event: 'setup', stage, reasonCode });
  }

  attach(gateway) {
    if (this.delegate === gateway) return;
    this.detach();
    this.delegate = gateway;
    gateway?.on?.('incoming', this._forwardIncoming);
    gateway?.on?.('event', this._forwardEvent);
    gateway?.on?.('monitorPcm', this._forwardMonitorPcm);
  }

  detach() {
    this.delegate?.off?.('incoming', this._forwardIncoming);
    this.delegate?.off?.('event', this._forwardEvent);
    this.delegate?.off?.('monitorPcm', this._forwardMonitorPcm);
    this.delegate = null;
  }

  status() {
    if (this.delegate) return { ...this.delegate.status(), setup: { ...this.setup } };
    return {
      identity: 'HARDWARE', simulator: false, state: 'running',
      device: { connected: false, authenticated: false, transport: 'usb', phase: 'disconnected' },
      setup: { ...this.setup },
    };
  }

  capabilities() {
    if (this.delegate) return this.delegate.capabilities();
    return {
      identity: 'HARDWARE', simulator: false, tools: [...LOCAL_TOOLS],
      transport: 'stdio', protocolVersion: '2024-11-05',
      phoneRequiredFor: ['dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak'],
      offline: { recordings: this.recording !== null, providerConfiguration: this.providerSettings !== null },
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

  syncRecording(args) {
    if (!this.delegate?.syncRecording) throw new Error('phone recording sync unavailable');
    return this.delegate.syncRecording(args);
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
    if (!this.agentAnswering?.status) throw new Error('agent answering settings unavailable');
    return this.agentAnswering.status();
  }

  configureAgentAnswering(args) {
    if (!this.agentAnswering?.configure) throw new Error('agent answering settings unavailable');
    return this.agentAnswering.configure(args);
  }

  providerCatalog(args) {
    if (!this.providerSettings?.catalog) throw new Error('provider catalog unavailable');
    return this.providerSettings.catalog(args);
  }

  providerHealth(args) {
    if (this.delegate) return this.delegate.providerHealth(args);
    if (typeof this.checkProviderHealth !== 'function') throw new Error('realtime is inactive');
    return this.checkProviderHealth(args);
  }

  testProviders() {
    if (this.delegate) return this.delegate.testProviders();
    if (typeof this.runProviderTest !== 'function') throw new Error('realtime is inactive');
    return this.runProviderTest();
  }

  async prewarmSpeech(args) {
    if (typeof this.prewarmTts !== 'function') throw new Error('realtime is inactive');
    await this.prewarmTts(args);
    return { ready: true };
  }

  provisionDeviceEvidence(args) {
    if (this.delegate) return this.delegate.provisionDeviceEvidence(args);
    return Promise.resolve({ accepted: false, reason: 'phone_not_connected' });
  }

  #live(method, args) {
    if (this.delegate) return this.delegate[method](args);
    return Promise.resolve({ accepted: false, reason: 'phone disconnected' });
  }

  dial(args) { return this.#live('dial', args); }
  answer(args) { return this.#live('answer', args); }
  reject(args) { return this.#live('reject', args); }
  hangup(args) { return this.#live('hangup', args); }
  sendDtmf(args) { return this.#live('sendDtmf', args); }
  speak(args) { return this.#live('speak', args); }

  manualAudioAvailable(args) {
    return this.delegate?.manualAudioAvailable?.(args) === true;
  }

  sendManualPcm(args) {
    if (!this.delegate?.sendManualPcm) throw new Error('phone audio unavailable');
    return this.delegate.sendManualPcm(args);
  }
}

function bootstrapIdentity(config, selected) {
  const identity = selected.identity;
  return {
    serial: selected.serial,
    product: identity.product,
    device: identity.device,
    api: Number(identity.api),
    systemFingerprint: identity.fingerprint,
    vendorFingerprint: identity.vendorFingerprint,
    packageName: config.bootstrap.packageName,
    versionCode: config.bootstrap.versionCode,
    signingCertSha256: config.bootstrap.signingCertSha256,
    artifactManifestSha256: config.bootstrap.artifactManifestSha256,
    desktopBootstrapVersion: 1,
  };
}

export function classifyPhoneSetupFailure(error, stage) {
  const code = String(error?.code ?? '');
  const message = `${error?.message ?? ''}\n${error?.stderr ?? ''}`.toLowerCase();
  if (code === 'ADB_AUTHORIZATION_REQUIRED' || message.includes('unauthorized')) {
    return { stage: 'WAITING_FOR_PHONE', reasonCode: 'usb_debugging_authorization_required' };
  }

  if (code === 'ADB_DEVICE_OFFLINE' || message.includes('device offline')) {
    return { stage: 'WAITING_FOR_PHONE', reasonCode: 'phone_offline' };
  }
  if (message.includes('multiple devices')) {
    return { stage: 'WAITING_FOR_PHONE', reasonCode: 'multiple_phones_connected' };
  }
  if (message.includes('identity mismatch')) {
    return { stage: 'BLOCKED', reasonCode: 'unsupported_phone_build' };
  }
  if (message.includes('permission denied') || code === 'EACCES') {
    return { stage: 'BLOCKED', reasonCode: 'usb_access_denied' };
  }
  if (stage === 'PAIRING' && /(?:econnrefused|timed out|timeout|closed|reset)/.test(message)) {
    return { stage: 'WAITING_FOR_PHONE_START', reasonCode: 'phone_app_not_ready' };
  }
  if (stage === 'AUTHENTICATING') {
    return { stage: 'PAIRING', reasonCode: 'secure_pairing_failed' };
  }
  return { stage: 'WAITING_FOR_PHONE', reasonCode: 'phone_not_connected' };
}

export async function runGatewayd({
  env = process.env,
  signals = process,
  createRecordingManager = (options) => new RecordingManager(options),
  createCallerMemory = (options) => new CallerMemoryStore(options),
  createProviderSettings = (options) => new ProviderSettingsStore(options),
  createAgentAnsweringSettings = (options) => new AgentAnsweringSettingsStore(options),
  createPhoneDataStore = (options) => new PhoneDataStore(options),
  createRealtimeRegistry = buildRealtimeRegistry,
  loadControllerSecret = readControllerSecret,
  loadRedactionSalt = readRedactionSalt,
  loadOrCreateRedactionSalt = readOrCreateRedactionSalt,
  loadMatchedArtifact = readMatchedArtifact,
  createPhoneSimulator = (options) => new PhoneSimulator(options),
  createGateway = (options) => new Gateway(options),
  createRpcServer = (gateway, options) => new GatewayRpcServer(gateway, options),
  createControllerCredentialStore = (options) => new ControllerCredentialStore(options),
  createAdbManager = (options) => new AdbManager(options),
  createBootstrapTransport = (options) => new BootstrapTransport(options),
  createBootstrapClient = (options) => new BootstrapClient(options),
  createDeviceClient = (options) => new DeviceClient(options),
  createNetworkBootstrapTransport = (options) => new NetworkBootstrapTransport(options),
  createNetworkDeviceClient = (options) => new NetworkDeviceClient(options),
  createNetworkAdbManager = (options) => new NetworkAdbManager(options),
  phoneRetryMs = 5_000,
  setRetryTimer = setTimeout,
  clearRetryTimer = clearTimeout,
} = {}) {
  if (!Number.isInteger(phoneRetryMs) || phoneRetryMs < 100 || phoneRetryMs > 300_000) {
    throw new Error('phone retry interval is invalid');
  }
  let baseEnv = env;
  const manifestPath = env.AGENTCALL_MATCHED_ARTIFACT_FILE;
  if ((env.AGENTCALL_MODE ?? 'hardware') === 'hardware' && manifestPath) {
    const { manifest, digest } = await loadMatchedArtifact(manifestPath);
    baseEnv = {
      ...env,
      AGENTCALL_APK_VERSION_CODE: String(manifest.androidVersionCode),
      AGENTCALL_APK_SIGNING_CERT_SHA256: manifest.androidSigningCertificateSha256,
      AGENTCALL_ARTIFACT_MANIFEST_SHA256: digest.toString('hex'),
    };
  }
  const providerSettings = createProviderSettings({ path: providerSettingsPathFromEnv(baseEnv), fallbackEnv: baseEnv });
  const agentAnswering = createAgentAnsweringSettings({ path: agentAnsweringPathFromEnv(baseEnv) });
  const runtimeEnv = await providerSettings.runtimeEnv(baseEnv);
  const config = configFromEnv(runtimeEnv);
  const rpcSocketPath = rpcSocketFromEnv(env);
  const zeroTouch = config.mode === 'hardware' && config.bootstrap !== undefined;
  let controllerSecret = config.mode === 'simulator'
    ? randomBytes(32)
    : (zeroTouch ? null : await loadControllerSecret(config.controllerSecretFile));
  let simulator = null;
  let gateway = null;
  let rpc = null;
  let stopPromise = null;
  let adb = null;
  let operationalForward = null;
  let device = null;
  let control = null;
  let retryTimer = null;
  let stopping = false;
  try {
    const redactionSalt = config.mode === 'simulator'
      ? config.gateway.idempotencySalt
      : (zeroTouch
        ? await loadOrCreateRedactionSalt(config.redactionSaltFile)
        : await loadRedactionSalt(config.redactionSaltFile));
    const recordingExportRoot = rpcSocketPath.startsWith('/')
      ? posix.join(posix.dirname(rpcSocketPath), 'recording-exports')
      : join(dirname(config.recording.root), 'recording-exports');
    const recording = createRecordingManager({
      ...config.recording,
      exportRoot: recordingExportRoot,
    });
    const phoneData = createPhoneDataStore({ root: join(dirname(config.recording.root), 'phone-data') });
    const callerMemory = config.callerMemory.enabled ? createCallerMemory(config.callerMemory) : null;
    let createRealtimeSession = null;
    let checkProviderHealth = null;
    let testProviders = null;
    let prewarmSpeech = null;
    if (config.realtime.enabled) {
      const registry = createRealtimeRegistry(config.realtime, runtimeEnv, {
        artifactPath: runtimeEnv.AGENTCALL_PROVIDER_TEST_PATH || join(dirname(rpcSocketPath), 'provider-test.wav'),
      });
      createRealtimeSession = createRealtimeFactory({
        config: config.realtime,
        sttProviders: registry.sttProviders,
        ttsProviders: registry.ttsProviders,
      });
      checkProviderHealth = registry.checkHealth;
      testProviders = registry.testSpeech;
      prewarmSpeech = registry.prewarmSpeech;
      void registry.prewarmGreetings?.().catch(() => {});
    }

    if (zeroTouch) {
      const store = createControllerCredentialStore({ path: config.controllerSecretFile });
      adb = createAdbManager({
        adbPath: config.gateway.adbPath,
        adbHome: config.gateway.adbHome,
        serverSocket: config.gateway.adbServerSocket,
        expectedIdentity: config.gateway.expectedIdentity,
      });
      control = new LocalControlPlane({
        recording, providerSettings, agentAnswering, phoneData,
        checkProviderHealth, testProviders, prewarmSpeech,
      });
      rpc = createRpcServer(control, { socketPath: rpcSocketPath });
      await rpc.start();

      const cleanupPhone = async () => {
        const ownedGateway = gateway;
        const ownedDevice = device;
        const ownedForward = operationalForward;
        gateway = null;
        device = null;
        operationalForward = null;
        try { await ownedGateway?.stop(); } catch {}
        try { await ownedDevice?.disconnect(); } catch {}
        if (ownedForward) try { await adb.killForward(ownedForward); } catch {}
      };
      const scheduleRetry = () => {
        if (stopping || retryTimer) return;
        retryTimer = setRetryTimer(() => {
          retryTimer = null;
          void connectPhone();
        }, phoneRetryMs);
        retryTimer?.unref?.();
      };
      const connectPhone = async () => {
        if (stopping || control.delegate) return;
        let bootstrapForward = null;
        try {
          const recovery = await store.recover();
          controllerSecret = await store.load();
          control.setStage('VERIFYING_DEVICE');
          const candidate = recovery.serial
            ? await adb.selectBySerial(recovery.serial)
            : await adb.selectOne();
          const selected = await adb.verifyIdentity(candidate.serial);
          const g2Authenticate = async (key) => {
            control.setStage('AUTHENTICATING');
            operationalForward = await adb.forward({
              serial: selected.serial,
              hostPort: config.gateway.hostPort,
              phonePort: config.start.phonePort,
            });
            device = createDeviceClient({ enrollmentSecret: Buffer.from(key) });
            await device.connect({ host: '127.0.0.1', port: config.gateway.hostPort });
          };
          if (recovery.state === 'committed') {
            if (!controllerSecret) throw new Error('committed controller credential is missing');
            // Android may still be staged after a crash immediately following
            // its G2 server proof, so authenticate before normal gateway start.
            await g2Authenticate(controllerSecret);
          } else if (recovery.state === 'staged') {
            const client = createBootstrapClient({ store, transport: {}, g2Authenticate });
            await client.recover(recovery);
            controllerSecret = await store.load();
          } else if (recovery.state === 'absent') {
            control.setStage('WAITING_FOR_PHONE_START', 'phone_start_required');
            bootstrapForward = await adb.forwardBootstrap({ serial: selected.serial });
            control.setStage('PAIRING');
            const transport = createBootstrapTransport({ host: '127.0.0.1', port: bootstrapForward.hostPort });
            const client = createBootstrapClient({
              store,
              transport,
              g2Authenticate,
            });
            await client.pair({ identity: bootstrapIdentity(config, selected) });
            controllerSecret = await store.load();
          } else {
            throw new Error('controller credential state is invalid');
          }
          if (!controllerSecret) throw new Error('controller credential commit is missing');
          gateway = createGateway({
            ...config.gateway,
            idempotencySalt: redactionSalt,
            controllerSecret: Buffer.from(controllerSecret),
            recording,
            phoneData,
            providerSettings,
            agentAnswering,
            ...(device ? { device, adb } : {}),
            ...(callerMemory ? { callerMemory } : {}),
            ...(createRealtimeSession
              ? { createRealtimeSession, checkProviderHealth, testProviders, prewarmSpeech }
              : {}),
          });
          await gateway.start({ ...config.start, ...(operationalForward ? { existingForward: operationalForward } : {}) });
          const evidenceArgs = deviceEvidenceProvisioningArgs(selected);
          if (evidenceArgs && typeof gateway.provisionDeviceEvidence === 'function') {
            const evidence = await gateway.provisionDeviceEvidence(evidenceArgs);
            if (evidence?.accepted !== true) {
              throw new Error('matched device evidence provisioning failed');
            }
          }
          control.attach(gateway);
          control.setStage('AUTHENTICATED');
          device = gateway.device ?? device;
          device?.on?.('state', (state) => {
            if (state !== 'connected' && !stopping) {
              control.detach();
              control.setStage('WAITING_FOR_PHONE', 'phone_not_connected');
              void cleanupPhone().then(scheduleRetry);
            }
          });
        } catch (error) {
          const failure = classifyPhoneSetupFailure(error, control.setup.stage);
          control.detach();
          await cleanupPhone();
          control.setStage(failure.stage, failure.reasonCode);
          scheduleRetry();
        } finally {
          if (bootstrapForward) try { await adb.killForward(bootstrapForward); } catch {}
          controllerSecret?.fill(0);
          controllerSecret = null;
        }
      };
      const stop = () => {
        stopping = true;
        if (retryTimer) clearRetryTimer(retryTimer);
        retryTimer = null;
        stopPromise ??= (async () => {
          control.detach();
          await rpc.stop();
          await cleanupPhone();
        })();
        return stopPromise;
      };
      signals.once?.('SIGTERM', stop);
      signals.once?.('SIGINT', stop);
      await connectPhone();
      return { gateway: control, rpc, simulator: null, stop };
    }

    // Network mode: connect directly to phone over TCP, no ADB required.
    if (config.mode === 'network') {
      const store = createControllerCredentialStore({ path: config.controllerSecretFile });
      control = new LocalControlPlane({
        recording, providerSettings, agentAnswering, phoneData,
        checkProviderHealth, testProviders, prewarmSpeech,
      });
      rpc = createRpcServer(control, { socketPath: rpcSocketPath });
      await rpc.start();

      const cleanupNetwork = async () => {
        const ownedGateway = gateway;
        const ownedDevice = device;
        gateway = null;
        device = null;
        try { await ownedGateway?.stop(); } catch {}
        try { await ownedDevice?.disconnect(); } catch {}
      };
      const scheduleRetry = () => {
        if (stopping || retryTimer) return;
        retryTimer = setRetryTimer(() => {
          retryTimer = null;
          void connectNetworkPhone();
        }, phoneRetryMs);
        retryTimer?.unref?.();
      };
      const connectNetworkPhone = async () => {
        if (stopping || control.delegate) return;
        try {
          const recovery = await store.recover();
          controllerSecret = await store.load();
          control.setStage('VERIFYING_DEVICE');
          const g2Authenticate = async (key) => {
            control.setStage('AUTHENTICATING');
            device = createNetworkDeviceClient({ host: config.phoneHost, port: config.phonePort, enrollmentSecret: Buffer.from(key) });
            await device.connect();
          };
          if (recovery.state === 'committed') {
            if (!controllerSecret) throw new Error('committed controller credential is missing');
            await g2Authenticate(controllerSecret);
          } else if (recovery.state === 'staged') {
            const transport = createNetworkBootstrapTransport({ host: config.phoneHost, port: config.phonePort });
            const client = createBootstrapClient({ store, transport, g2Authenticate });
            await client.recover(recovery);
            controllerSecret = await store.load();
          } else if (recovery.state === 'absent') {
            control.setStage('WAITING_FOR_PHONE_START', 'phone_start_required');
            const transport = createNetworkBootstrapTransport({ host: config.phoneHost, port: config.phonePort });
            const client = createBootstrapClient({ store, transport, g2Authenticate });
            const identity = {
              serial: 'NETWORK-PHONE',
              product: 'lineage_miatoll',
              device: 'gram',
              api: 35,
              systemFingerprint: 'network/system/device:15/AP3A/public:user/release-keys',
              vendorFingerprint: 'network/vendor/device:15/AP3A/public:user/release-keys',
              packageName: 'com.callagent.gateway',
              versionCode: 333,
              signingCertSha256: '0'.repeat(64),
              artifactManifestSha256: '0'.repeat(64),
              desktopBootstrapVersion: 1,
            };
            await client.pair({ identity });
            controllerSecret = await store.load();
          } else {
            throw new Error('controller credential state is invalid');
          }
          if (!controllerSecret) throw new Error('controller credential commit is missing');
          gateway = createGateway({
            ...config.gateway,
            mode: 'network',
            idempotencySalt: redactionSalt,
            controllerSecret: Buffer.from(controllerSecret),
            phoneHost: config.phoneHost,
            phonePort: config.phonePort,
            recording,
            phoneData,
            providerSettings,
            agentAnswering,
            ...(callerMemory ? { callerMemory } : {}),
            ...(createRealtimeSession
              ? { createRealtimeSession, checkProviderHealth, testProviders, prewarmSpeech }
              : {}),
          });
          await gateway.start({ phoneHost: config.phoneHost, phonePort: config.phonePort });
          control.attach(gateway);
          control.setStage('AUTHENTICATED');
          device = gateway.device ?? device;
          device?.on?.('state', (state) => {
            if (state !== 'connected' && !stopping) {
              control.detach();
              control.setStage('WAITING_FOR_PHONE', 'phone_not_connected');
              void cleanupNetwork().then(scheduleRetry);
            }
          });
        } catch (error) {
          const message = `${error?.message ?? ''}`.toLowerCase();
          let failureStage = 'WAITING_FOR_PHONE';
          let failureReason = 'phone_not_connected';
          if (/econnrefused|timed out|timeout|closed|reset/.test(message)) {
            failureReason = 'phone_unreachable';
          } else if (message.includes('authentication failed')) {
            failureStage = 'PAIRING';
            failureReason = 'secure_pairing_failed';
          }
          control.detach();
          await cleanupNetwork();
          control.setStage(failureStage, failureReason);
          scheduleRetry();
        } finally {
          controllerSecret?.fill(0);
          controllerSecret = null;
        }
      };
      const stop = () => {
        stopping = true;
        if (retryTimer) clearRetryTimer(retryTimer);
        retryTimer = null;
        stopPromise ??= (async () => {
          control.detach();
          await rpc.stop();
          await cleanupNetwork();
        })();
        return stopPromise;
      };
      signals.once?.('SIGTERM', stop);
      signals.once?.('SIGINT', stop);
      await connectNetworkPhone();
      return { gateway: control, rpc, simulator: null, stop };
    }

    simulator = config.mode === 'simulator'
      ? createPhoneSimulator({ port: 0, enrollmentSecret: Buffer.from(controllerSecret) })
      : null;
    const simulatorEndpoint = simulator ? await simulator.start() : null;
    gateway = createGateway({
      ...config.gateway,
      idempotencySalt: redactionSalt,
      controllerSecret: Buffer.from(controllerSecret),
      recording,
      phoneData,
      providerSettings,
      agentAnswering,
      ...(simulator ? { runtimeIdentity: { identity: 'SIMULATOR', simulator: true } } : {}),
      ...(callerMemory ? { callerMemory } : {}),
      ...(createRealtimeSession
        ? { createRealtimeSession, checkProviderHealth, testProviders, prewarmSpeech }
        : {}),
    });
    rpc = createRpcServer(gateway, { socketPath: rpcSocketPath });
    const stop = () => {
      stopping = true;
      stopPromise ??= (async () => {
        await rpc.stop();
        await gateway.stop();
        await simulator?.stop();
      })();
      return stopPromise;
    };
    signals.once?.('SIGTERM', stop);
    signals.once?.('SIGINT', stop);
    const start = simulatorEndpoint ? { ...config.start, phonePort: simulatorEndpoint.port } : config.start;
    await rpc.start();
    if (stopping) {
      await stop();
      throw new Error('gatewayd stopped during startup');
    }
    await gateway.start(start);
    if (stopping) {
      await stop();
      await gateway.stop();
      throw new Error('gatewayd stopped during startup');
    }
    return { gateway, rpc, simulator, stop };
  } catch (error) {
    try { await stopPromise; } catch {}
    if (!stopPromise) {
      try { await rpc?.stop(); } catch {}
      try { await gateway?.stop(); } catch {}
      try { await device?.disconnect(); } catch {}
      if (operationalForward) try { await adb?.killForward(operationalForward); } catch {}
      try { await simulator?.stop(); } catch {}
    }
    throw error;
  } finally {
    controllerSecret?.fill(0);
  }
}

export function isGatewaydEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
  return Boolean(argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl));
}

if (isGatewaydEntrypoint()) {
  try {
    await runGatewayd();
  } catch {
    process.stderr.write('gatewayd start failed\n');
    process.exitCode = 1;
  }
}
