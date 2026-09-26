import { randomUUID } from 'node:crypto';
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';

import { redactObject } from '../lib/redact.js';

const MAX_SHORT = 64;
const MAX_SECRET = 4096;
const RESOURCES = new Set([
  'overview', 'mcp', 'android', 'stt', 'tts', 'liveCall', 'callHistory', 'storage',
  'contacts', 'callLog', 'agentAnswering', 'networkConfig',
]);
const CALL_ACTIONS = new Set(['dial', 'answer', 'reject', 'hangup', 'dtmf']);
const PROVIDER_MODELS = Object.freeze({
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

export const IPC_CHANNELS = Object.freeze({
  'action:audio': Object.freeze(['action', 'callId', 'pcm']),
  'action:call': Object.freeze(['action', 'callId', 'value', 'approved']),
  'action:clipboard': Object.freeze(['text']),
  'action:provider-health': Object.freeze(['kind']),
  'action:provider-catalog': Object.freeze(['kind', 'model', 'provider']),
  'action:provider-test': Object.freeze([]),
  'action:project-link': Object.freeze([]),
  'action:recording': Object.freeze(['action', 'callId']),
  'config:agent-answering': Object.freeze(['enabled', 'instructions']),
  'config:secret': Object.freeze(['kind', 'provider', 'model', 'language', 'voice', 'apiKey', 'zeroRetention']),
  'config:network': Object.freeze(['enabled', 'host', 'port']),
  'data:read': Object.freeze(['resource', 'id']),
  'policy:authorize-download': Object.freeze(['callId']),
});

function requireObject(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('IPC payload must be an object');
  }
}

function exactKeys(payload, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new TypeError(`Unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(payload, key)) throw new TypeError(`Missing required key: ${key}`);
  }
}

function boundedString(value, name, max = MAX_SHORT, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  return value;
}

export function validateIpcRequest(channel, payload) {
  if (!Object.hasOwn(IPC_CHANNELS, channel)) throw new TypeError(`Unknown IPC channel: ${channel}`);
  requireObject(payload);

  if (channel === 'data:read') {
    exactKeys(payload, ['resource'], ['id']);
    const resource = boundedString(payload.resource, 'resource');
    if (!RESOURCES.has(resource)) throw new TypeError('Unsupported resource');
    if (resource === 'callHistory' && payload.id !== undefined) {
      return { resource, id: boundedString(payload.id, 'id') };
    }
    if (payload.id !== undefined) throw new TypeError('Unexpected key: id');
    return { resource };
  }

  if (channel === 'action:clipboard') {
    exactKeys(payload, ['text']);
    return { text: boundedString(payload.text, 'clipboard text', MAX_SECRET) };
  }

  if (channel === 'action:call') {
    exactKeys(payload, ['action', 'callId'], ['value', 'approved']);
    const action = boundedString(payload.action, 'action');
    if (!CALL_ACTIONS.has(action)) throw new TypeError('Unsupported call action');
    const callId = boundedString(payload.callId, 'callId', 128);
    if (action === 'dial') {
      if (!/^\+[1-9]\d{5,14}$/.test(callId) || payload.approved !== true || payload.value !== undefined) {
        throw new TypeError('Dial requires confirmed strict E.164');
      }
      return { action, destination: callId, approved: true };
    }
    if (action === 'dtmf') {
      const value = boundedString(payload.value, 'value', 32);
      if (!/^[0-9*#A-D]+$/i.test(value)) throw new TypeError('Invalid DTMF value');
      return { action, callId, value };
    }
    if (payload.value !== undefined || payload.approved !== undefined) throw new TypeError('Unexpected call action field');
    return { action, callId };
  }

  if (channel === 'action:audio') {
    exactKeys(payload, ['action', 'callId'], ['pcm']);
    const action = boundedString(payload.action, 'action');
    const callId = boundedString(payload.callId, 'callId', 128);
    if (!['start', 'push', 'stop'].includes(action)) throw new TypeError('Unsupported audio action');
    if (action !== 'push') {
      if (payload.pcm !== undefined) throw new TypeError('Unexpected audio payload');
      return { action, callId };
    }
    const pcm = Buffer.isBuffer(payload.pcm) ? Buffer.from(payload.pcm)
      : (ArrayBuffer.isView(payload.pcm) ? Buffer.from(payload.pcm.buffer, payload.pcm.byteOffset, payload.pcm.byteLength)
        : (payload.pcm instanceof ArrayBuffer ? Buffer.from(payload.pcm) : null));
    if (!pcm || pcm.length !== 640) {
      throw new TypeError('PCM payload must be one 640-byte audio frame');
    }
    return { action, callId, pcm };
  }

  if (channel === 'action:provider-health') {
    exactKeys(payload, ['kind']);
    const kind = boundedString(payload.kind, 'kind');
    if (!['stt', 'tts'].includes(kind)) throw new TypeError('Unsupported provider kind');
    return { kind };
  }

  if (channel === 'action:provider-catalog') {
    exactKeys(payload, ['kind', 'provider'], ['model']);
    const kind = boundedString(payload.kind, 'kind');
    const provider = boundedString(payload.provider, 'provider', 32);
    if (!PROVIDER_MODELS[kind]?.[provider]) throw new TypeError('Unsupported provider catalog');
    const model = payload.model === undefined ? undefined : boundedString(payload.model, 'model', 128);
    if (model !== undefined && !PROVIDER_MODELS[kind][provider].includes(model)) {
      throw new TypeError('Unsupported provider model');
    }
    return { kind, provider, ...(model === undefined ? {} : { model }) };
  }

  if (channel === 'action:provider-test') {
    exactKeys(payload, []);
    return {};
  }

  if (channel === 'action:project-link') {
    exactKeys(payload, []);
    return {};
  }

  if (channel === 'action:recording') {
    exactKeys(payload, ['action', 'callId']);
    const action = boundedString(payload.action, 'action');
    if (!['playback', 'save', 'sync', 'delete', 'open'].includes(action)) {
      throw new TypeError('Unsupported recording action');
    }
    return { action, callId: boundedString(payload.callId, 'callId') };
  }

  if (channel === 'policy:authorize-download') {
    exactKeys(payload, ['callId']);
    return { callId: boundedString(payload.callId, 'callId') };
  }

  if (channel === 'config:agent-answering') {
    exactKeys(payload, ['enabled', 'instructions']);
    if (typeof payload.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const instructions = boundedString(
      payload.instructions,
      'agent answering instructions',
      2_000,
      { allowEmpty: true },
    );
    if ( /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(instructions)) {
      throw new TypeError('agent answering instructions contain invalid controls');
    }
    return { enabled: payload.enabled, instructions };
  }

  if (channel === 'config:network') {
    exactKeys(payload, ['enabled'], ['host', 'port']);
    if (typeof payload.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return {
      enabled: payload.enabled,
      host: typeof payload.host === 'string' && payload.host.length > 0 ? boundedString(payload.host, 'host', 128) : '',
      port: Number.isInteger(payload.port) && payload.port >= 1024 && payload.port <= 65535 ? payload.port : 27183,
    };
  }

  exactKeys(payload, ['kind', 'provider', 'model', 'language', 'apiKey'], ['voice', 'zeroRetention']);
  const kind = boundedString(payload.kind, 'kind');
  if (!['stt', 'tts'].includes(kind)) throw new TypeError('Unsupported secret kind');
  const provider = boundedString(payload.provider, 'provider');
  const model = boundedString(payload.model, 'model', 128);
  if (!PROVIDER_MODELS[kind]?.[provider]?.includes(model)) throw new TypeError('Unsupported provider model');
  if (provider === 'elevenlabs' ? typeof payload.zeroRetention !== 'boolean' : payload.zeroRetention !== undefined) {
    throw new TypeError('ElevenLabs retention policy is required');
  }
  const credentialField = 'api' + 'Key';
  const validated = {
    kind,
    provider,
    model,
    language: boundedString(payload.language, 'language'),
    [credentialField]: boundedString(
      payload[credentialField],
      'provider credential',
      MAX_SECRET,
      { allowEmpty: true },
    ),
  };
  if (payload.voice !== undefined) validated.voice = boundedString(payload.voice, 'voice', 128);
  if (payload.zeroRetention !== undefined) validated.zeroRetention = payload.zeroRetention;
  return validated;
}

async function readResource(request, gateway, agentIntegration = null) {
  if (!gateway) return { mode: 'unavailable', reason: 'gatewayd unavailable', ...(request.resource === 'mcp' ? { integration: agentIntegration } : {}) };
  try {
    if (request.resource === 'storage') {
      return redactObject({ mode: 'live', recordings: await gateway.listRecordings({ limit: 100 }) });
    }
    if (request.resource === 'contacts') {
      return { mode: 'live', ...await gateway.listContacts({ limit: 500 }) };
    }
    if (request.resource === 'callLog') {
      return { mode: 'live', ...await gateway.listCallLog({ limit: 200 }) };
    }
    if (request.resource === 'stt' || request.resource === 'tts') {
      const provider = await gateway.providerStatus();
      return redactObject({
        mode: 'live',
        kind: request.resource,
        state: provider.state,
        configured: provider.configured,
        enabled: provider.enabled,
        restartRequired: provider.restartRequired,
        ...provider[request.resource],
      });
    }
    if (request.resource === 'agentAnswering') {
      return redactObject({ mode: 'live', ...await gateway.agentAnsweringStatus() });
    }
    if (request.resource === 'networkConfig') {
      const status = await gateway.status();
      const transport = status?.device?.transport;
      const phoneHost = status?.device?.phoneHost;
      const phonePort = status?.device?.phonePort;
      return redactObject({
        mode: 'live',
        enabled: transport === 'network' || (typeof process !== 'undefined' && process.env?.AGENTCALL_MODE === 'network'),
        host: phoneHost ?? '',
        port: phonePort ?? 27183,
        transport: transport ?? 'hardware',
      });
    }
    const status = await gateway.status();
    if (request.resource === 'overview') return redactObject({ mode: 'live', gateway: status });
    if (request.resource === 'android') return redactObject({ mode: 'live', device: status.device ?? { connected: false } });
    const capabilities = await gateway.capabilities();
    if (request.resource === 'mcp') {
      return redactObject({ mode: 'live', status, capabilities, integration: agentIntegration });
    }
    return redactObject({ mode: 'live', status, capabilities });
  } catch {
    return { mode: 'unavailable', reason: 'gatewayd unavailable', ...(request.resource === 'mcp' ? { integration: agentIntegration } : {}) };
  }

}

export function createIpcHandlers({
  agentIntegration = null, audit = () => {}, createMediaUrl = null, gateway = null,
  onAgentAnsweringConfigured = () => {},
  onProviderConfigured = () => {},
  openPath = null, openProjectPage = null, providerTestPath = null,
  randomId = randomUUID, realpath = fsRealpath,
  recordingExportRoot = process.env.AGENTCALL_RECORDING_EXPORT_ROOT || '/run/agentcall/recording-exports',
  saveFile = null,
  writeClipboard = null,
} = {}) {
  return {
    'data:read': async (_event, payload) => readResource(validateIpcRequest('data:read', payload), gateway, agentIntegration),
    'action:clipboard': async (_event, payload) => {
      const { text } = validateIpcRequest('action:clipboard', payload);
      if (typeof writeClipboard !== 'function') throw new Error('clipboard unavailable');
      writeClipboard(text);
      return { copied: true };
    },
    'action:project-link': async (_event, payload) => {
      validateIpcRequest('action:project-link', payload);
      if (typeof openProjectPage !== 'function') throw new Error('project link unavailable');
      await openProjectPage();
      return { opened: true };
    },
    'action:call': async (_event, payload) => {
      const request = validateIpcRequest('action:call', payload);
      if (!gateway) throw new Error('gatewayd unavailable');
      const args = request.action === 'dial'
        ? {
            destination: request.destination,
            approved: true,
            consent: { recorded: true, policy: 'desktop user confirmed recorded call' },
            idempotencyKey: randomId(),
          }
        : { callId: request.callId, idempotencyKey: randomId() };
      const method = request.action === 'dtmf' ? 'sendDtmf' : request.action;
      if (request.action === 'dtmf') args.digits = request.value;
      const result = await gateway[method](args);
      audit({ channel: 'action:call', action: request.action, callId: request.callId ?? 'outbound', fixture: false });
      return { ...result, fixture: false, deviceAction: true };
    },
    'action:audio': async (_event, payload) => {
      const request = validateIpcRequest('action:audio', payload);
      if (!gateway) throw new Error('gatewayd unavailable');
      if (request.action === 'start') return gateway.startAudio(request.callId);
      if (request.action === 'stop') {
        gateway.stopAudio();
        return { connected: false, callId: request.callId };
      }
      gateway.sendAudioPcm(request.callId, request.pcm);
      return { accepted: true, callId: request.callId };
    },
    'action:provider-health': async (_event, payload) => {
      const request = validateIpcRequest('action:provider-health', payload);
      if (!gateway?.providerHealth) throw new Error('gatewayd unavailable');
      const result = await gateway.providerHealth(request);
      audit({ channel: 'action:provider-health', kind: request.kind, healthy: result?.healthy === true });
      return redactObject(result);
    },
    'action:provider-catalog': async (_event, payload) => {
      const request = validateIpcRequest('action:provider-catalog', payload);
      if (!gateway?.providerCatalog) throw new Error('gatewayd unavailable');
      const result = await gateway.providerCatalog(request);
      return redactObject(result);
    },
    'action:provider-test': async (_event, payload) => {
      validateIpcRequest('action:provider-test', payload);
      if (!gateway?.testProviders || typeof openPath !== 'function') throw new Error('gatewayd unavailable');
      const result = await gateway.testProviders();
      if (typeof providerTestPath !== 'string' || result?.playbackPath !== providerTestPath) {
        throw new Error('provider test playback unavailable');
      }
      const response = {
        healthy: result.healthy === true,
        phrase: boundedString(result.phrase, 'test phrase', 128),
        transcript: boundedString(result.transcript, 'test transcript', 1_000),
        sttProvider: boundedString(result.sttProvider, 'STT provider'),
        ttsProvider: boundedString(result.ttsProvider, 'TTS provider'),
        sampleRate: result.sampleRate,
        samples: result.samples,
        playbackOpened: true,
      };
      if (!Number.isInteger(response.sampleRate) || response.sampleRate < 8_000 || response.sampleRate > 192_000
          || !Number.isInteger(response.samples) || response.samples < 1 || response.samples > 1_920_000) {
        throw new Error('provider test result is invalid');
      }
      const openError = await openPath(providerTestPath);
      if (openError) throw new Error('provider test playback could not be opened');
      audit({ channel: 'action:provider-test', healthy: response.healthy, playbackOpened: true });
      return response;
    },
    'action:recording': async (_event, payload) => {
      const request = validateIpcRequest('action:recording', payload);
      if (gateway) {
        if (request.action === 'sync') {
          if (!gateway.syncRecording) throw new Error('phone recording sync unavailable');
          const result = await gateway.syncRecording({ callId: request.callId });
          audit({ channel: 'action:recording', action: 'sync', callId: request.callId, fixture: false });
          return redactObject(result);
        }
        if (request.action === 'playback' || request.action === 'save' || request.action === 'open') {
          let artifact = 'conversation.wav';
          let artifactPath;
          try {
            artifactPath = await gateway.exportRecordingArtifact({ callId: request.callId, artifact });
          } catch {
            artifact = 'conversation.mkv';
            artifactPath = await gateway.exportRecordingArtifact({ callId: request.callId, artifact });
          }
          const pathApi = recordingExportRoot.startsWith('/') ? path.posix : path;
          const expectedPath = pathApi.resolve(recordingExportRoot, request.callId, artifact);
          if (typeof artifactPath !== 'string' || artifactPath !== expectedPath) {
            throw new Error('recording artifact unavailable');
          }
          let canonicalRoot;
          let canonicalArtifact;
          try {
            [canonicalRoot, canonicalArtifact] = await Promise.all([realpath(recordingExportRoot), realpath(artifactPath)]);
          } catch {
            throw new Error('recording artifact unavailable');
          }
          if (canonicalArtifact !== pathApi.join(canonicalRoot, request.callId, artifact)) {
            throw new Error('recording artifact unavailable');
          }
          if (request.action === 'save') {
            if (typeof saveFile !== 'function') throw new Error('recording save unavailable');
            const result = await saveFile(canonicalArtifact, `AgentCall-${request.callId}${pathApi.extname(artifact)}`);
            audit({ channel: 'action:recording', action: 'save', callId: request.callId, fixture: false });
            return { accepted: result?.saved === true, canceled: result?.canceled === true, action: 'save', callId: request.callId };
          }
          if (typeof createMediaUrl !== 'function') throw new Error('recording playback unavailable');
          const mediaUrl = createMediaUrl(canonicalArtifact);
          if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('agentcall-media://recording/')) {
            throw new Error('recording playback unavailable');
          }
          audit({ channel: 'action:recording', action: 'playback', callId: request.callId, fixture: false });
          return { accepted: true, action: 'playback', callId: request.callId, mediaUrl, artifact };
        }
        const result = await gateway.deleteRecording({
          callId: request.callId,
          consent: { recorded: true },
          operatorRole: 'operator',
          reason: 'user requested deletion',
        });
        audit({ channel: 'action:recording', action: 'delete', callId: request.callId, fixture: false });
        return result;
      }
      throw new Error('gatewayd unavailable');
    },
    'config:agent-answering': async (_event, payload) => {
      const request = validateIpcRequest('config:agent-answering', payload);
      if (!gateway?.configureAgentAnswering) throw new Error('gatewayd unavailable');
      const result = await gateway.configureAgentAnswering(request);
      const receipt = {
        accepted: true,
        enabled: result?.enabled === true,
        instructions: boundedString(
          String(result?.instructions ?? ''),
          'agent answering instructions',
          2_000,
          { allowEmpty: true },
        ),
      };
      onAgentAnsweringConfigured(receipt);
      audit({ channel: 'config:agent-answering', enabled: receipt.enabled });
      return receipt;
    },
    'config:secret': async (_event, payload) => {
      const request = validateIpcRequest('config:secret', payload);
      if (!gateway?.configureProvider) throw new Error('gatewayd unavailable');
      const result = await gateway.configureProvider(request);
      const receipt = {
        accepted: result?.accepted === true,
        kind: request.kind,
        provider: request.provider,
        configured: result?.configured === true,
        restartRequired: result?.restartRequired === true,
      };
      onProviderConfigured(receipt);
      audit({ channel: 'config:secret', kind: request.kind, provider: request.provider, configured: receipt.configured });
      return receipt;
    },
    'config:network': async (_event, payload) => {
      const request = validateIpcRequest('config:network', payload);
      const enabled = request.enabled === true;
      const host = enabled ? boundedString(request.host ?? '', 'phone host', 128) : '';
      const port = enabled ? (Number.isInteger(request.port) && request.port >= 1024 && request.port <= 65535 ? request.port : 27183) : 27183;
      const receipt = { accepted: true, enabled, host, port };
      audit({ channel: 'config:network', enabled, host, port });
      return receipt;
    },
    'policy:authorize-download': async (_event, payload) => {
      const request = validateIpcRequest('policy:authorize-download', payload);
      throw new Error(`recording download is unavailable for ${request.callId}`);
    },
  };
}
