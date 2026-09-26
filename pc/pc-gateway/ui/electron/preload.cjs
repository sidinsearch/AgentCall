'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = new Set([
  'action:audio',
  'action:call',
  'action:clipboard',
  'action:provider-health',
  'action:provider-catalog',
  'action:provider-test',
  'action:project-link',
  'action:recording',
  'config:agent-answering',
  'config:secret',
  'config:network',
  'data:read',
  'policy:authorize-download',
]);

const invoke = (channel, payload) => {
  if (!IPC_CHANNELS.has(channel)) return Promise.reject(new Error('IPC channel is not allowed'));
  return ipcRenderer.invoke(channel, payload);
};

const ROUTES = new Set(['calls', 'contacts', 'live-call', 'mcp', 'android', 'speech', 'recordings', 'policy', 'settings']);

const api = Object.freeze({
  read: (resource, id) => invoke('data:read', id === undefined ? { resource } : { resource, id }),
  copyText: (text) => invoke('action:clipboard', { text }),
  call: (action, callId, value) => invoke('action:call', value === undefined ? { action, callId } : { action, callId, value }),
  dial: (destination) => invoke('action:call', { action: 'dial', callId: destination, approved: true }),
  startManualAudio: (callId) => invoke('action:audio', { action: 'start', callId }),
  pushManualAudio: (callId, pcm) => invoke('action:audio', { action: 'push', callId, pcm }),
  stopManualAudio: (callId) => invoke('action:audio', { action: 'stop', callId }),
  onManualAudio: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('audio callback must be a function');
    const listener = (_event, frame) => {
      if (frame && typeof frame.callId === 'string' && frame.pcm instanceof Uint8Array) callback(frame);
    };
    ipcRenderer.on('audio:downlink', listener);
    return () => ipcRenderer.removeListener('audio:downlink', listener);
  },
  onManualAudioClosed: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('audio close callback must be a function');
    const listener = (_event, frame) => { if (frame && typeof frame.callId === 'string') callback(frame); };
    ipcRenderer.on('audio:closed', listener);
    return () => ipcRenderer.removeListener('audio:closed', listener);
  },
  onGatewayEvent: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('gateway event callback must be a function');
    const listener = (_event, frame) => { if (frame && typeof frame === 'object') callback(frame); };
    ipcRenderer.on('gateway:event', listener);
    return () => ipcRenderer.removeListener('gateway:event', listener);
  },
  playRecording: (callId) => invoke('action:recording', { action: 'playback', callId }),
  saveRecording: (callId) => invoke('action:recording', { action: 'save', callId }),
  syncRecording: (callId) => invoke('action:recording', { action: 'sync', callId }),
  deleteRecording: (callId) => invoke('action:recording', { action: 'delete', callId }),
  authorizeDownload: (callId) => invoke('policy:authorize-download', { callId }),
  checkProviderHealth: (kind) => invoke('action:provider-health', { kind }),
  loadProviderCatalog: (kind, provider, model) => invoke(
    'action:provider-catalog',
    { kind, provider, ...(model === undefined ? {} : { model }) },
  ),
  testProviders: () => invoke('action:provider-test', {}),
  openProjectPage: () => invoke('action:project-link', {}),
  saveSecret: (config) => invoke('config:secret', config),
  saveAgentAnswering: (config) => invoke('config:agent-answering', config),
  configureNetwork: (config) => invoke('config:network', config),
  onNavigate: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('navigation callback must be a function');
    const listener = (_event, route) => { if (ROUTES.has(route)) callback(route); };
    ipcRenderer.on('navigation:route', listener);
    return () => ipcRenderer.removeListener('navigation:route', listener);
  },
});

contextBridge.exposeInMainWorld('gatewayDesktop', api);
