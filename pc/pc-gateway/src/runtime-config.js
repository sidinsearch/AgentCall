import { isAbsolute } from 'node:path';

const SERIAL_RE = /^[A-Za-z0-9._-]{3,64}$/;
const DEFAULT_RPC_SOCKET = '/run/agentcall/gatewayd.sock';
const DEFAULT_RECORDING_ROOT = '/var/lib/agentcall/recordings';
const DEFAULT_RECORDING_MIN_FREE_BYTES = 1024 * 1024 * 1024;
export const E164_RE = /^\+[1-9]\d{5,14}$/;
const REALTIME_MODELS = Object.freeze({
  stt: Object.freeze({
    openai: Object.freeze([
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'gpt-4o-mini-transcribe-2025-12-15',
      'whisper-1',
    ]),
    elevenlabs: Object.freeze(['scribe_v2_realtime']),
  }),
  tts: Object.freeze({
    supertonic: Object.freeze(['supertonic-3']),
    elevenlabs: Object.freeze(['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']),
    openai: Object.freeze(['gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']),
  }),
});

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  if (value.startsWith('REPLACE_WITH_')) throw new Error(`${name} placeholder is not allowed`);
  return value;
}

export function rpcSocketFromEnv(env = process.env) {
  const socketPath = env.AGENTCALL_RPC_SOCKET || DEFAULT_RPC_SOCKET;
  if (typeof socketPath !== 'string' || socketPath.length < 2 || socketPath.length > 200 || !isAbsolute(socketPath)) {
    throw new Error('AGENTCALL_RPC_SOCKET must be an absolute path up to 200 characters');
  }
  return socketPath;
}

function port(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`${name} must be a numeric port`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} port out of range`);
  return value;
}

function realtimeConfig(env) {
  const rawEnabled = env.AGENTCALL_REALTIME_ENABLED ?? 'false';
  if (rawEnabled !== 'true' && rawEnabled !== 'false') throw new Error('AGENTCALL_REALTIME_ENABLED must be true or false');
  if (rawEnabled === 'false') return { enabled: false };
  const sttProvider = required(env, 'AGENTCALL_STT_PROVIDER');
  if (!['openai', 'elevenlabs'].includes(sttProvider)) throw new Error('AGENTCALL_STT_PROVIDER is unsupported');
  const ttsProvider = required(env, 'AGENTCALL_TTS_PROVIDER');
  if (!['supertonic', 'elevenlabs', 'openai'].includes(ttsProvider)) throw new Error('AGENTCALL_TTS_PROVIDER is unsupported');
  const sttModel = env.AGENTCALL_STT_MODEL || REALTIME_MODELS.stt[sttProvider][0];
  if (!REALTIME_MODELS.stt[sttProvider].includes(sttModel)) throw new Error('AGENTCALL_STT_MODEL is unsupported');
  const ttsModel = env.AGENTCALL_TTS_MODEL || REALTIME_MODELS.tts[ttsProvider][0];
  if (!REALTIME_MODELS.tts[ttsProvider].includes(ttsModel)) throw new Error('AGENTCALL_TTS_MODEL is unsupported');
  const voice = required(env, 'AGENTCALL_TTS_VOICE');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(voice)) throw new Error('AGENTCALL_TTS_VOICE has an invalid shape');
  const fallbackLanguage = env.AGENTCALL_REALTIME_LANGUAGE || 'en';
  const sttLanguage = env.AGENTCALL_STT_LANGUAGE || fallbackLanguage;
  const ttsLanguage = env.AGENTCALL_TTS_LANGUAGE || fallbackLanguage;
  if (!/^[a-z]{2,3}$/.test(sttLanguage)) throw new Error('AGENTCALL_STT_LANGUAGE has an invalid shape');
  if (!/^[a-z]{2,3}$/.test(ttsLanguage)) throw new Error('AGENTCALL_TTS_LANGUAGE has an invalid shape');
  const usesElevenLabs = sttProvider === 'elevenlabs' || ttsProvider === 'elevenlabs';
  const retention = env.AGENTCALL_ELEVENLABS_ZERO_RETENTION;
  if (usesElevenLabs && retention !== 'true' && retention !== 'false') {
    throw new Error('AGENTCALL_ELEVENLABS_ZERO_RETENTION must explicitly be true or false');
  }
  return {
    enabled: true, sttProvider, sttModel, ttsProvider, ttsModel, voice, sttLanguage, ttsLanguage,
    ...(usesElevenLabs ? { elevenLabsZeroRetention: retention === 'true' } : {}),
  };
}

function callerMemoryConfig(env) {
  const rawEnabled = env.AGENTCALL_CALLER_MEMORY_ENABLED ?? 'false';
  if (rawEnabled !== 'true' && rawEnabled !== 'false') throw new Error('AGENTCALL_CALLER_MEMORY_ENABLED must be true or false');
  if (rawEnabled === 'false') return { enabled: false };
  const root = required(env, 'AGENTCALL_CALLER_MEMORY_ROOT');
  if (root.length > 300 || !isAbsolute(root)) throw new Error('AGENTCALL_CALLER_MEMORY_ROOT must be an absolute path up to 300 characters');
  const secret = required(env, 'AGENTCALL_CALLER_MEMORY_SECRET');
  if (secret.length < 16 || secret.length > 4096) throw new Error('AGENTCALL_CALLER_MEMORY_SECRET must be 16..4096 characters');
  return { enabled: true, root, secret };
}

function recordingConfig(env) {
  const root = env.AGENTCALL_RECORDING_ROOT || DEFAULT_RECORDING_ROOT;
  if (typeof root !== 'string' || root.length < 2 || root.length > 300 || !isAbsolute(root)) {
    throw new Error('recording root must be an absolute path up to 300 characters');
  }
  const rawMinFree = env.AGENTCALL_RECORDING_MIN_FREE_BYTES ?? String(DEFAULT_RECORDING_MIN_FREE_BYTES);
  if (!/^\d+$/.test(rawMinFree)) throw new Error('recording minimum free bytes must be a nonnegative integer');
  const minFreeBytes = Number(rawMinFree);
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1) {
    throw new Error('recording minimum free bytes must be a positive safe integer');
  }
  const ffmpegPath = env.AGENTCALL_FFMPEG_PATH || 'ffmpeg';
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length < 1 || ffmpegPath.length > 300
      || (!/^[A-Za-z0-9._-]+$/.test(ffmpegPath) && !isAbsolute(ffmpegPath))) {
    throw new Error('recording ffmpeg path has an invalid shape');
  }
  return { root, minFreeBytes, ffmpegPath };
}

function dialPolicy(env) {
  const rawEnabled = env.AGENTCALL_DIAL_ENABLED ?? 'true';
  if (rawEnabled !== 'true' && rawEnabled !== 'false') throw new Error('AGENTCALL_DIAL_ENABLED must be true or false');
  const dialEnabled = rawEnabled === 'true';
  if (!dialEnabled) return { dialEnabled: false };
  const raw = env.AGENTCALL_DIAL_ALLOW_NUMBERS;
  if (raw === undefined || raw === '') return { dialEnabled: true, allowNumbers: [], requireManualApproval: true };
  const allowNumbers = raw.split(',');
  if (allowNumbers.length === 0 || allowNumbers.length > 32
      || allowNumbers.some((number) => !E164_RE.test(number))) {
    throw new Error('AGENTCALL_DIAL_ALLOW_NUMBERS allowlist is invalid');
  }
  if (new Set(allowNumbers).size !== allowNumbers.length) {
    throw new Error('AGENTCALL_DIAL_ALLOW_NUMBERS allowlist contains duplicates');
  }
  return { dialEnabled: true, allowNumbers, requireManualApproval: true };
}

export function configFromEnv(env = process.env) {
  const mode = env.AGENTCALL_MODE ?? 'hardware';
  if (mode !== 'hardware' && mode !== 'simulator' && mode !== 'network') {
    throw new Error('AGENTCALL_MODE must be hardware, simulator, or network');
  }
  const hostPort = port(env, 'AGENTCALL_HOST_PORT', 5040);
  const phonePort = port(env, 'AGENTCALL_PHONE_PORT', 27183);
  const common = {
    mode,
    recording: recordingConfig(env),
    realtime: realtimeConfig(env),
    callerMemory: callerMemoryConfig(env),
  };
  if (mode === 'simulator') {
    return {
      ...common,
      gateway: {
        hostPort,
        phonePort,
        idempotencySalt: env.AGENTCALL_REDACTION_SALT || 'agentcall-local',
        policy: dialPolicy(env),
      },
      start: { simulator: true, phoneHost: '127.0.0.1' },
    };
  }

  if (mode === 'network') {
    // Network mode: connect to phone over TCP, no ADB.
    const phoneHost = env.AGENTCALL_PHONE_HOST;
    if (!phoneHost || !/^([a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?|\d{1,3}(\.\d{1,3}){3})$/.test(phoneHost)) {
      throw new Error('AGENTCALL_PHONE_HOST is required for network mode and must be a valid hostname or IP');
    }
    const controllerSecretFile = env.AGENTCALL_CONTROLLER_SECRET_FILE || '/var/lib/agentcall/controller/controller.key';
    const redactionSaltFile = env.AGENTCALL_REDACTION_SALT_FILE || '/var/lib/agentcall/redaction-salt';
    if (controllerSecretFile.length > 300 || !isAbsolute(controllerSecretFile)) {
      throw new Error('AGENTCALL_CONTROLLER_SECRET_FILE must be an absolute path up to 300 characters');
    }
    if (redactionSaltFile.length > 300 || !isAbsolute(redactionSaltFile)) {
      throw new Error('AGENTCALL_REDACTION_SALT_FILE must be an absolute path up to 300 characters');
    }
    return {
      ...common,
      phoneHost,
      phonePort,
      controllerSecretFile,
      redactionSaltFile,
      gateway: {
        hostPort,
        phonePort,
        idempotencySalt: env.AGENTCALL_REDACTION_SALT || 'agentcall-local',
        policy: dialPolicy(env),
      },
      start: { phoneHost, phonePort },
    };
  }

  const serial = env.AGENTCALL_DEVICE_SERIAL;
  if (serial !== undefined && (serial.startsWith('REPLACE_WITH_') || !SERIAL_RE.test(serial))) {
    throw new Error('AGENTCALL_DEVICE_SERIAL has an invalid shape');
  }
  const fingerprint = env.AGENTCALL_DEVICE_FINGERPRINT;
  if (fingerprint?.startsWith('REPLACE_WITH_')) throw new Error('AGENTCALL_DEVICE_FINGERPRINT placeholder is not allowed');
  const bootstrapFields = [
    'AGENTCALL_APK_VERSION_CODE', 'AGENTCALL_APK_SIGNING_CERT_SHA256',
    'AGENTCALL_ARTIFACT_MANIFEST_SHA256',
  ];
  const bootstrapPresent = bootstrapFields.filter((name) => env[name] !== undefined);
  if (bootstrapPresent.length !== 0 && bootstrapPresent.length !== bootstrapFields.length) {
    throw new Error('zero-touch bootstrap artifact identity must be configured completely');
  }
  let bootstrap;
  if (bootstrapPresent.length === bootstrapFields.length) {
    const versionCode = Number(env.AGENTCALL_APK_VERSION_CODE);
    const digest = /^[a-f0-9]{64}$/;
    if (!Number.isSafeInteger(versionCode) || versionCode < 1
        || !digest.test(env.AGENTCALL_APK_SIGNING_CERT_SHA256)
        || !digest.test(env.AGENTCALL_ARTIFACT_MANIFEST_SHA256)) {
      throw new Error('zero-touch bootstrap artifact identity is invalid');
    }
    bootstrap = {
      packageName: 'com.callagent.gateway', versionCode,
      signingCertSha256: env.AGENTCALL_APK_SIGNING_CERT_SHA256,
      artifactManifestSha256: env.AGENTCALL_ARTIFACT_MANIFEST_SHA256,
    };
  }
  const controllerSecretFile = env.AGENTCALL_CONTROLLER_SECRET_FILE || '/var/lib/agentcall/controller/controller.key';
  const redactionSaltFile = env.AGENTCALL_REDACTION_SALT_FILE || '/var/lib/agentcall/redaction-salt';
  if (controllerSecretFile.length > 300 || !isAbsolute(controllerSecretFile)) {
    throw new Error('AGENTCALL_CONTROLLER_SECRET_FILE must be an absolute path up to 300 characters');
  }
  if (redactionSaltFile.length > 300 || !isAbsolute(redactionSaltFile)) {
    throw new Error('AGENTCALL_REDACTION_SALT_FILE must be an absolute path up to 300 characters');
  }
  return {
    ...common,
    serial,
    controllerSecretFile,
    redactionSaltFile,
    ...(bootstrap ? { bootstrap } : {}),
    gateway: {
      adbPath: env.AGENTCALL_ADB_PATH || 'adb',
      adbHome: env.AGENTCALL_ADB_HOME || '/var/lib/agentcall/adb',
      adbServerSocket: env.AGENTCALL_ADB_SERVER_SOCKET || 'tcp:127.0.0.1:15037',
      hostPort,
      phonePort,
      expectedIdentity: {
        product: 'lineage_miatoll', device: 'gram', api: '35',
        ...(fingerprint ? { fingerprint } : {}),
      },
      policy: dialPolicy(env),
    },
    start: { ...(serial ? { serial } : {}), phoneHost: '127.0.0.1', phonePort },
  };
}
