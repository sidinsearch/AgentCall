// No-op ADB manager for network mode.
// Network mode does not use ADB — the phone is reached via TCP directly.
// This module exists so gateway.js can use a uniform interface regardless of mode.

import { isAbsolute } from 'node:path';

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/;
const PORT_RE = /^\d{1,5}$/;

export function isValidHost(host) {
  return typeof host === 'string' && host.length >= 1 && host.length <= 128 && HOST_RE.test(host);
}

export function isValidPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function parseHostPort(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const host = m[1];
  const port = Number(m[2]);
  if (!isValidHost(host) || !isValidPort(port)) return null;
  return { host, port };
}

export class NetworkAdbManager {
  constructor(opts = {}) {
    this.phoneHost = opts.phoneHost;
    this.phonePort = opts.phonePort;
    if (!isValidHost(this.phoneHost)) {
      throw new Error('network mode requires a valid phoneHost');
    }
    if (!isValidPort(this.phonePort)) {
      throw new Error('network mode requires a valid phonePort (1024-65535)');
    }
    this.adbPath = null;
    this.adbHome = null;
    this.serverSocket = null;
    this.expectedIdentity = opts.expectedIdentity ?? null;
    this._devices = [];
  }

  async listDevices() {
    // No ADB in network mode. The "device" is the phone at phoneHost:phonePort.
    // Returns a synthetic single device entry representing the network phone.
    return [{
      serial: 'NETWORK-PHONE',
      state: 'device',
      product: null,
      model: null,
      name: null,
      transportId: 0,
    }];
  }

  async forward(serial, phonePort, hostPort) {
    // No forwarding needed in network mode.
    return [];
  }

  async removeForward(serial, phonePort) {
    return;
  }

  disconnect() {
    return;
  }

  destroy() {
    return;
  }
}
