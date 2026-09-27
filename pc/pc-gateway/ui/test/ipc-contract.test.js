import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IPC_CHANNELS,
  createIpcHandlers,
  validateIpcRequest,
} from '../electron/ipc.js';

test('IPC exposes only the declared channel allowlist', () => {
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), [
    'action:audio',
    'action:call',
    'action:clipboard',
    'action:project-link',
    'action:provider-catalog',
    'action:provider-health',
    'action:provider-test',
    'action:recording',
    'config:agent-answering',
    'config:network',
    'config:secret',
    'data:read',
    'policy:authorize-download',
  ]);
  assert.equal(Object.isFrozen(IPC_CHANNELS), true);
});

test('manual audio IPC accepts only exact 20 ms PCM frames for the correlated call', async () => {
  const calls = [];
  const gateway = {
    startAudio: async (callId) => (calls.push(['start', callId]), { connected: true, callId }),
    sendAudioPcm: (callId, pcm) => calls.push(['push', callId, Buffer.from(pcm)]),
    stopAudio: () => calls.push(['stop']),
  };
  const handlers = createIpcHandlers({ gateway });
  const pcm = new Int16Array(320);
  assert.equal((await handlers['action:audio'](null, {
    action: 'start', callId: 'call-audio-1',
  })).connected, true);
  assert.equal((await handlers['action:audio'](null, {
    action: 'push', callId: 'call-audio-1', pcm,
  })).accepted, true);
  await handlers['action:audio'](null, { action: 'stop', callId: 'call-audio-1' });
  assert.deepEqual(calls.map(([name]) => name), ['start', 'push', 'stop']);
  assert.equal(calls[1][2].length, 640);
  await assert.rejects(handlers['action:audio'](null, {
    action: 'push', callId: 'call-audio-1', pcm: new Uint8Array(641),
  }), /640-byte|PCM/i);
  await assert.rejects(handlers['action:audio'](null, {
    action: 'push', callId: 'call-audio-1', pcm: new Uint8Array(638),
  }), /640-byte|PCM/i);
  await assert.rejects(handlers['action:audio'](null, {
    action: 'start', callId: 'call-audio-1', pcm: new Uint8Array(2),
  }), /unexpected/i);
});

test('IPC schemas accept exact request keys and reject extras', () => {
  assert.deepEqual(validateIpcRequest('data:read', { resource: 'overview' }), { resource: 'overview' });
  assert.throws(
    () => validateIpcRequest('data:read', { resource: 'overview', injected: true }),
    /unexpected key/i,
  );
  assert.throws(() => validateIpcRequest('unknown:channel', {}), /channel/i);
  assert.throws(() => validateIpcRequest('action:call', { action: 'dial' }), /callId/i);
  assert.throws(
    () => validateIpcRequest('config:secret', { kind: 'stt', provider: 'local', apiKey: 'x', debug: true }),
    /unexpected key/i,
  );
});

test('clipboard IPC accepts only bounded setup text', async () => {
  const copied = [];
  const handlers = createIpcHandlers({ writeClipboard: (text) => copied.push(text) });
  assert.deepEqual(validateIpcRequest('action:clipboard', { text: 'hermes mcp list' }), { text: 'hermes mcp list' });
  await assert.rejects(handlers['action:clipboard'](null, { text: 'x'.repeat(4097) }), /bounded/i);
  assert.deepEqual(await handlers['action:clipboard'](null, { text: 'hermes mcp list' }), { copied: true });
  assert.deepEqual(copied, ['hermes mcp list']);
});

test('project link IPC opens only the fixed application repository target', async () => {
  let opened = 0;
  const handlers = createIpcHandlers({ openProjectPage: async () => { opened += 1; } });
  assert.deepEqual(await handlers['action:project-link'](null, {}), { opened: true });
  assert.equal(opened, 1);
  await assert.rejects(
    handlers['action:project-link'](null, { url: 'https://example.invalid' }),
    /unexpected key/i,
  );
});

test('AI incoming-call IPC stores only bounded context and explicit mode', async () => {
  const calls = [];
  const configured = [];
  const gateway = {
    agentAnsweringStatus: async () => ({
      enabled: true,
      instructions: 'I am in a meeting. Ask why they called.',
    }),
    configureAgentAnswering: async (request) => {
      calls.push(request);
      return request;
    },
  };
  const handlers = createIpcHandlers({
    gateway,
    onAgentAnsweringConfigured: (receipt) => configured.push(receipt),
  });
  assert.deepEqual(await handlers['data:read'](null, { resource: 'agentAnswering' }), {
    mode: 'live',
    enabled: true,
    instructions: 'I am in a meeting. Ask why they called.',
  });
  assert.deepEqual(await handlers['config:agent-answering'](null, {
    enabled: true,
    instructions: 'Collect the caller name and reason.',
  }), {
    accepted: true,
    enabled: true,
    instructions: 'Collect the caller name and reason.',
  });
  assert.deepEqual(calls, [{
    enabled: true,
    instructions: 'Collect the caller name and reason.',
  }]);
  assert.deepEqual(configured, [{
    accepted: true,
    enabled: true,
    instructions: 'Collect the caller name and reason.',
  }]);
  await assert.rejects(handlers['config:agent-answering'](null, {
    enabled: true,
    instructions: 'x'.repeat(2_001),
  }), /bounded/i);
  await assert.rejects(handlers['config:agent-answering'](null, {
    enabled: true,
    instructions: 'hello',
    extra: true,
  }), /unexpected/i);
});

test('write-only provider IPC persists through gatewayd and never returns or logs submitted secret', async () => {
  const logEntries = [];
  const calls = [];
  const gateway = {
    configureProvider: async (request) => {
      calls.push(request);
      return {
        accepted: true,
        kind: request.kind,
        provider: request.provider,
        configured: true,
        restartRequired: true,
        credentialValue: secret,
        internalPath: '/var/lib/agentcall/provider-settings.json',
        nested: { authorizationMaterial: secret },
      };
    },
  };
  const handlers = createIpcHandlers({ gateway, audit: (entry) => logEntries.push(entry) });
  const secret = 'not-a-real-secret-value';
  const result = await handlers['config:secret'](null, {
    kind: 'stt',
    provider: 'openai',
    model: 'gpt-4o-transcribe',
    language: 'en',
    apiKey: secret,
  });

  assert.deepEqual(result, {
    accepted: true,
    kind: 'stt',
    provider: 'openai',
    configured: true,
    restartRequired: true,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(logEntries).includes(secret), false);
  assert.deepEqual(calls, [{
    kind: 'stt', provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', apiKey: secret,
  }]);
});

test('provider IPC allowlist accepts supported OpenAI TTS models only', () => {
  const request = {
    kind: 'tts', provider: 'openai', model: 'gpt-4o-mini-tts-2025-12-15',
    language: 'en', voice: 'alloy', apiKey: 'ipc-test-key',
  };
  assert.deepEqual(validateIpcRequest('config:secret', request), request);
  assert.deepEqual(
    validateIpcRequest('config:secret', { ...request, model: 'gpt-4o-mini-tts', apiKey: '' }),
    { ...request, model: 'gpt-4o-mini-tts', apiKey: '' },
  );
  assert.throws(
    () => validateIpcRequest('config:secret', { ...request, model: 'unknown-model' }),
    /unsupported|model/i,
  );
});

test('provider configuration and health fail closed when gatewayd is unavailable', async () => {
  const handlers = createIpcHandlers();
  const credentialField = 'api' + 'Key';
  await assert.rejects(
    handlers['config:secret'](null, {
      kind: 'tts', provider: 'supertonic', model: 'supertonic-3', language: 'en', voice: 'F1',
      [credentialField]: '',
    }),
    /gatewayd unavailable/i,
  );
  await assert.rejects(handlers['action:provider-health'](null, { kind: 'stt' }), /gatewayd unavailable/i);
  await assert.rejects(handlers['action:provider-health'](null, { kind: 'stt', extra: true }), /unexpected/i);
  await assert.rejects(handlers['action:provider-health'](null, { kind: 'other' }), /kind/i);
  await assert.rejects(handlers['action:provider-catalog'](null, {
    kind: 'tts', provider: 'elevenlabs', model: 'eleven_flash_v2_5',
  }), /gatewayd unavailable/i);
});

test('provider catalog IPC loads bounded public choices without credential material', async () => {
  const calls = [];
  const gateway = {
    providerCatalog: async (request) => {
      calls.push(request);
      return {
        ...request,
        models: ['eleven_flash_v2_5'], languages: ['en', 'hi'],
        voices: [{ value: 'voice_123', label: 'Support Voice' }], voiceState: 'ready',
        apiKey: 'must-not-return',
      };
    },
  };
  const result = await createIpcHandlers({ gateway })['action:provider-catalog'](null, {
    kind: 'tts', provider: 'elevenlabs', model: 'eleven_flash_v2_5',
  });
  assert.deepEqual(calls, [{
    kind: 'tts', provider: 'elevenlabs', model: 'eleven_flash_v2_5',
  }]);
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
  assert.equal(result.voices[0].label, 'Support Voice');
  assert.throws(() => validateIpcRequest('action:provider-catalog', {
    kind: 'tts', provider: 'elevenlabs', model: 'unknown-model',
  }), /model/i);
});

test('live daemon backs overview, MCP, and Android resources without fixture claims', async () => {
  const calls = [];
  const gateway = {
    status: async () => {
      calls.push('status');
      return { state: 'running', device: { connected: true, serial: 'redacted' }, recording: { healthy: false } };
    },
    capabilities: async () => {
      calls.push('capabilities');
      return { tools: ['status', 'capabilities'] };
    },
  };
  const handlers = createIpcHandlers({ gateway });

  const overview = await handlers['data:read'](null, { resource: 'overview' });
  const mcp = await handlers['data:read'](null, { resource: 'mcp' });
  const android = await handlers['data:read'](null, { resource: 'android' });

  assert.equal(overview.mode, 'live');
  assert.equal(overview.gateway.state, 'running');
  assert.equal(mcp.mode, 'live');
  assert.deepEqual(mcp.capabilities.tools, ['status', 'capabilities']);
  assert.equal(android.mode, 'live');
  assert.equal(android.device.connected, true);
  assert.deepEqual(calls, ['status', 'status', 'capabilities', 'status']);
  assert.equal(JSON.stringify({ overview, mcp, android }).includes('fixture'), false);
});

test('live daemon exposes truthful active and pending provider state without secrets', async () => {
  const gateway = {
    providerStatus: async () => ({
      state: 'restart-required', configured: true, enabled: true, restartRequired: true,
      stt: { provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', configured: true, active: true },
      tts: { provider: 'supertonic', model: 'supertonic-3', language: 'en', voice: 'F2', configured: true, active: false },
    }),
  };
  const handlers = createIpcHandlers({ gateway });
  assert.deepEqual(await handlers['data:read'](null, { resource: 'stt' }), {
    mode: 'live', kind: 'stt', state: 'restart-required', configured: true,
    enabled: true, restartRequired: true,
    provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', configured: true, active: true,
  });
  assert.deepEqual(await handlers['data:read'](null, { resource: 'tts' }), {
    mode: 'live', kind: 'tts', state: 'restart-required', configured: true,
    enabled: true, restartRequired: true,
    provider: 'supertonic', model: 'supertonic-3', language: 'en', voice: 'F2', configured: true, active: false,
  });
});

test('contacts and call-log IPC expose only bounded local mirror rows with truthful sync state', async () => {
  const calls = [];
  const gateway = {
    listContacts: async (args) => {
      calls.push(['contacts', args]);
      return {
        rows: [{ id: '1', name: 'Ada', number: '+10000000001' }],
        sync: { state: 'ready', count: 1, syncedAt: '2026-07-22T00:00:00.000Z' },
      };
    },
    listCallLog: async (args) => {
      calls.push(['callLog', args]);
      return {
        rows: [{
          id: '2', number: '+10000000001', name: 'Ada', kind: 'incoming',
          timestampMillis: '1721606400000', durationSeconds: '42',
        }],
        sync: { state: 'offline', count: 1, syncedAt: '2026-07-22T00:00:00.000Z' },
      };
    },
  };
  const handlers = createIpcHandlers({ gateway });

  const contacts = await handlers['data:read'](null, { resource: 'contacts' });
  const callLog = await handlers['data:read'](null, { resource: 'callLog' });

  assert.deepEqual(contacts, {
    mode: 'live', rows: [{ id: '1', name: 'Ada', number: '+10000000001' }],
    sync: { state: 'ready', count: 1, syncedAt: '2026-07-22T00:00:00.000Z' },
  });
  assert.equal(callLog.rows[0].number, '+10000000001');
  assert.equal(callLog.sync.state, 'offline');
  assert.deepEqual(calls, [['contacts', { limit: 500 }], ['callLog', { limit: 200 }]]);
  assert.throws(() => validateIpcRequest('data:read', { resource: 'contacts', id: 'extra' }), /unexpected/i);
});

test('daemon read failures return an honest unavailable state', async () => {
  const gateway = {
    status: async () => { throw new Error('/run/agentcall/gatewayd.sock ENOENT'); },
    capabilities: async () => { throw new Error('not connected'); },
  };
  const handlers = createIpcHandlers({ gateway });
  const overview = await handlers['data:read'](null, { resource: 'overview' });

  assert.deepEqual(overview, { mode: 'unavailable', reason: 'gatewayd unavailable' });
});

test('provider health IPC forwards one bounded kind and audits no provider detail', async () => {
  const calls = [];
  const audit = [];
  const gateway = {
    providerHealth: async (args) => {
      calls.push(args);
      return {
        kind: args.kind, provider: 'openai', healthy: true, scope: 'credential',
        model: 'gpt-4o-transcribe', sampleRate: 24_000,
      };
    },
  };
  const handlers = createIpcHandlers({ gateway, audit: (event) => audit.push(event) });

  assert.deepEqual(await handlers['action:provider-health'](null, { kind: 'stt' }), {
    kind: 'stt', provider: 'openai', healthy: true, scope: 'credential',
    model: 'gpt-4o-transcribe', sampleRate: 24_000,
  });
  assert.deepEqual(calls, [{ kind: 'stt' }]);
  assert.deepEqual(audit, [{ channel: 'action:provider-health', kind: 'stt', healthy: true }]);
});

test('provider test IPC opens only the daemon artifact and returns no local path', async () => {
  const opened = [];
  const audit = [];
  const gateway = {
    testProviders: async () => ({
      healthy: true, phrase: 'AgentCall speech test.', transcript: 'AgentCall speech test.',
      sttProvider: 'openai', ttsProvider: 'supertonic', sampleRate: 16_000, samples: 640,
      playbackPath: '/run/agentcall/provider-test.wav',
    }),
  };
  const handlers = createIpcHandlers({
    gateway,
    providerTestPath: '/run/agentcall/provider-test.wav',
    openPath: async (path) => { opened.push(path); return ''; },
    audit: (event) => audit.push(event),
  });

  const result = await handlers['action:provider-test'](null, {});
  assert.deepEqual(result, {
    healthy: true, phrase: 'AgentCall speech test.', transcript: 'AgentCall speech test.',
    sttProvider: 'openai', ttsProvider: 'supertonic', sampleRate: 16_000, samples: 640,
    playbackOpened: true,
  });
  assert.equal(JSON.stringify(result).includes('/run/'), false);
  assert.deepEqual(opened, ['/run/agentcall/provider-test.wav']);
  assert.deepEqual(audit, [{ channel: 'action:provider-test', healthy: true, playbackOpened: true }]);
  await assert.rejects(handlers['action:provider-test'](null, { path: '/etc/passwd' }), /unexpected/i);
  const hostile = createIpcHandlers({
    gateway: { testProviders: async () => ({ ...result, playbackPath: '/etc/passwd' }) },
    providerTestPath: '/run/agentcall/provider-test.wav',
    openPath: async () => '',
  });
  await assert.rejects(hostile['action:provider-test'](null, {}), /playback unavailable/i);
});

test('provider test IPC validates bounded metadata before opening playback', async () => {
  const opened = [];
  const handlers = createIpcHandlers({
    gateway: {
      testProviders: async () => ({
        healthy: true,
        phrase: 'AgentCall speech test.',
        transcript: 'AgentCall speech test.',
        sttProvider: 'openai',
        ttsProvider: 'supertonic',
        sampleRate: 1,
        samples: 640,
        playbackPath: '/run/agentcall/provider-test.wav',
      }),
    },
    providerTestPath: '/run/agentcall/provider-test.wav',
    openPath: async (path) => { opened.push(path); return ''; },
  });

  await assert.rejects(handlers['action:provider-test'](null, {}), /result is invalid/i);
  assert.deepEqual(opened, []);
});

test('live call IPC routes exact correlated semantic mutations to gatewayd', async () => {
  const calls = [];
  const gateway = {
    answer: async (args) => (calls.push(['answer', args]), { accepted: true }),
    reject: async (args) => (calls.push(['reject', args]), { accepted: true }),
    hangup: async (args) => (calls.push(['hangup', args]), { accepted: true }),
    sendDtmf: async (args) => (calls.push(['sendDtmf', args]), { accepted: true }),
  };
  const handlers = createIpcHandlers({ gateway, randomId: () => 'fixed-key' });
  await handlers['action:call'](null, { action: 'answer', callId: 'call-1' });
  await handlers['action:call'](null, { action: 'reject', callId: 'call-1' });
  await handlers['action:call'](null, { action: 'hangup', callId: 'call-1' });
  await handlers['action:call'](null, { action: 'dtmf', callId: 'call-1', value: '12#' });
  assert.deepEqual(calls, [
    ['answer', { callId: 'call-1', idempotencyKey: 'fixed-key' }],
    ['reject', { callId: 'call-1', idempotencyKey: 'fixed-key' }],
    ['hangup', { callId: 'call-1', idempotencyKey: 'fixed-key' }],
    ['sendDtmf', { callId: 'call-1', digits: '12#', idempotencyKey: 'fixed-key' }],
  ]);
});

test('live recording IPC lists, plays, saves, syncs, and deletes without exposing local paths', async () => {
  const calls = [];
  const gateway = {
    listRecordings: async (args) => (calls.push(['list', args]), [{ callId: 'call-1', complete: true }]),
    exportRecordingArtifact: async (args) => (
      calls.push(['artifact', args]),
      '/run/agentcall/recording-exports/call-1/conversation.wav'
    ),
    syncRecording: async (args) => (calls.push(['sync', args]), { state: 'stored', callId: 'call-1', bytes: 42 }),
    deleteRecording: async (args) => (calls.push(['delete', args]), { deleted: true, callId: 'call-1' }),
  };
  const saved = [];
  const handlers = createIpcHandlers({
    gateway,
    recordingExportRoot: '/run/agentcall/recording-exports',
    realpath: async (path) => path,
    createMediaUrl: () => 'agentcall-media://recording/token',
    saveFile: async (path, name) => { saved.push([path, name]); return { saved: true, canceled: false }; },
  });

  const storage = await handlers['data:read'](null, { resource: 'storage' });
  const playback = await handlers['action:recording'](null, { action: 'playback', callId: 'call-1' });
  const save = await handlers['action:recording'](null, { action: 'save', callId: 'call-1' });
  const sync = await handlers['action:recording'](null, { action: 'sync', callId: 'call-1' });
  const deleted = await handlers['action:recording'](null, { action: 'delete', callId: 'call-1' });

  assert.deepEqual(storage, { mode: 'live', recordings: [{ callId: 'call-1', complete: true }] });
  assert.deepEqual(playback, {
    accepted: true, action: 'playback', callId: 'call-1',
    mediaUrl: 'agentcall-media://recording/token', artifact: 'conversation.wav',
  });
  assert.equal(JSON.stringify(playback).includes('/private/'), false);
  assert.deepEqual(save, { accepted: true, canceled: false, action: 'save', callId: 'call-1' });
  assert.deepEqual(sync, { state: 'stored', callId: 'call-1', bytes: 42 });
  assert.deepEqual(saved, [['/run/agentcall/recording-exports/call-1/conversation.wav', 'AgentCall-call-1.wav']]);
  assert.deepEqual(deleted, { deleted: true, callId: 'call-1' });
  assert.deepEqual(calls, [
    ['list', { limit: 100 }],
    ['artifact', { callId: 'call-1', artifact: 'conversation.wav' }],
    ['artifact', { callId: 'call-1', artifact: 'conversation.wav' }],
    ['sync', { callId: 'call-1' }],
    ['delete', { callId: 'call-1', consent: { recorded: true }, operatorRole: 'operator', reason: 'user requested deletion' }],
  ]);
});

test('recording open rejects noncanonical, traversal, and symlink-escaped daemon artifacts', async () => {
  const opened = [];
  for (const artifact of [
    '/etc/passwd',
    '/private/recordings/other/conversation.mkv',
    '/private/recordings/call-1/../other/conversation.mkv',
    42,
  ]) {
    const handlers = createIpcHandlers({
      gateway: { exportRecordingArtifact: async () => artifact },
      recordingExportRoot: '/run/agentcall/recording-exports',
      realpath: async (path) => path,
      openPath: async (path) => { opened.push(path); return ''; },
    });
    await assert.rejects(handlers['action:recording'](null, { action: 'playback', callId: 'call-1' }), /artifact unavailable/i);
  }
  const escaped = createIpcHandlers({
    gateway: { exportRecordingArtifact: async () => '/run/agentcall/recording-exports/call-1/conversation.wav' },
    recordingExportRoot: '/run/agentcall/recording-exports',
    realpath: async (path) => path.endsWith('conversation.wav') ? '/etc/passwd' : path,
    createMediaUrl: () => 'agentcall-media://recording/token',
  });
  await assert.rejects(escaped['action:recording'](null, { action: 'playback', callId: 'call-1' }), /artifact unavailable/i);
  assert.deepEqual(opened, []);
});

test('unavailable daemon never falls back to fixtures or claims device actions', async () => {
  const handlers = createIpcHandlers();
  const overview = await handlers['data:read'](null, { resource: 'overview' });

  assert.deepEqual(overview, { mode: 'unavailable', reason: 'gatewayd unavailable' });
  await assert.rejects(
    handlers['action:call'](null, { action: 'answer', callId: 'call-unavailable-001' }),
    /gatewayd unavailable/i,
  );
  await assert.rejects(
    handlers['action:recording'](null, { action: 'playback', callId: 'call-unavailable-001' }),
    /gatewayd unavailable/i,
  );
  await assert.rejects(
    handlers['policy:authorize-download'](null, { callId: 'call-unavailable-001' }),
    /unavailable/i,
  );
});
