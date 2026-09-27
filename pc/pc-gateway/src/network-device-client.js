// PC-side client for a TCP-served framed socket (network mode, no ADB).
// Connects to phone-host:phone-port instead of loopback.
// Reuses the same framing, auth, and session contract as DeviceClient.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  FrameAccumulator,
  encodeFrame,
  encodePcmFrame,
  encodeControlFrame,
  encodeEventFrame,
  encodeArtifactFrame,
  KIND_CONTROL,
  KIND_EVENT,
  KIND_PCM,
  KIND_ARTIFACT,
  DIR_HOST_TO_DEVICE,
  DIR_DEVICE_TO_HOST,
  PCM_FRAME_BYTES,
} from './framing.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 27183;
const AUTH_MAGIC_SERVER_HELLO = Buffer.from('G2A1');
const AUTH_MAGIC_CLIENT_PROOF = Buffer.from('G2C1');
const AUTH_MAGIC_SERVER_PROOF = Buffer.from('G2S1');
const AUTH_NONCE_BYTES = 32;
const AUTH_PROOF_BYTES = 32;
const AUTH_CLIENT_RECORD_BYTES = 4 + AUTH_NONCE_BYTES + AUTH_PROOF_BYTES;
const AUTH_CLIENT_DOMAIN = Buffer.from('agentcall-controller-client-v1\0', 'ascii');
const AUTH_SERVER_DOMAIN = Buffer.from('agentcall-controller-server-v1\0', 'ascii');
const AUTH_SESSION_DOMAIN = Buffer.from('agentcall-controller-session-v1\0', 'ascii');

function authProof(secret, domain, serverNonce, clientNonce) {
  return createHmac('sha256', secret)
    .update(domain, 'ascii')
    .update(serverNonce)
    .update(clientNonce)
    .digest();
}

export class NetworkDeviceClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.sessionId = opts.sessionId ?? 1;
    if (opts.enrollmentSecret !== undefined
      && (!Buffer.isBuffer(opts.enrollmentSecret) || opts.enrollmentSecret.length !== 32)) {
      throw new TypeError('enrollmentSecret must be exactly 32 bytes');
    }
    this._enrollmentSecret = opts.enrollmentSecret ? Buffer.from(opts.enrollmentSecret) : null;
    this.authTimeoutMs = opts.authTimeoutMs ?? 3000;
    this.sendQueueLimit = opts.sendQueueLimit ?? 256;
    this._socket = null;
    this._acc = new FrameAccumulator();
    this._sendQueue = [];
    this._flushing = false;
    this._txSeq = 0;
    this._rxLastSeq = new Map();
    this._state = 'disconnected';
    this._metrics = {
      receivedPcm: 0,
      receivedControl: 0,
      receivedEvent: 0,
      receivedArtifact: 0,
      sentPcm: 0,
      sentControl: 0,
      sentEvent: 0,
      sentArtifact: 0,
      authFailures: 0,
      connectionAttempts: 0,
    };
  }

  get state() { return this._state; }
  get metrics() { return { ...this._metrics }; }

  async connect() {
    if (this._state !== 'disconnected') return;
    this._state = 'connecting';
    this._metrics.connectionAttempts++;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this._socket = socket;
        this._state = 'connected';
        this._startReadLoop();
        this._startAuth();
        resolve();
      });
      socket.on('error', (err) => {
        this._state = 'disconnected';
        reject(err);
      });
      socket.on('close', () => {
        if (this._state === 'connected' || this._state === 'connecting') {
          this._state = 'disconnected';
          this._onDisconnect('connection closed');
        }
      });
      this._socket = socket;
    });
  }

  disconnect() {
    if (this._state === 'disconnected') return;
    this._state = 'disconnected';
    const socket = this._socket;
    this._socket = null;
    this._acc.reset();
    this._sendQueue = [];
    this._rxLastSeq = new Map();
    if (socket) socket.destroy();
    this.emit('disconnected');
  }

  sendControl(payload) {
    return this._enqueue(KIND_CONTROL, DIR_HOST_TO_DEVICE, payload);
  }

  sendEvent(payload) {
    return this._enqueue(KIND_EVENT, DIR_HOST_TO_DEVICE, payload);
  }

  sendPcm(payload) {
    return this._enqueue(KIND_PCM, DIR_HOST_TO_DEVICE, payload);
  }

  sendArtifact(payload) {
    return this._enqueue(KIND_ARTIFACT, DIR_HOST_TO_DEVICE, payload);
  }

  _enqueue(kind, direction, payload) {
    if (this._state !== 'connected' || !this._socket || !this._socket.writable) return false;
    const frame = encodeFrame({ kind, direction, sessionId: this.sessionId, sequence: this._txSeq++, timestampMicros: BigInt(Date.now()) * 1000n, payload });
    if (this._sendQueue.length >= this.sendQueueLimit) {
      this._metrics.sentPcm = this._metrics.sentPcm + (kind === KIND_PCM ? 1 : 0);
      return false; // backpressure: drop
    }
    this._sendQueue.push(frame);
    this._flush();
    return true;
  }

  _flush() {
    if (this._flushing || this._sendQueue.length === 0 || !this._socket || !this._socket.writable) return;
    this._flushing = true;
    const socket = this._socket;
    let offset = 0;
    const queue = this._sendQueue;
    const tryFlush = () => {
      while (offset < queue.length && socket.writable) {
        const frame = queue[offset];
        const written = socket.write(frame);
        if (written) offset++;
        else break;
      }
      if (offset === queue.length) {
        this._sendQueue = [];
        this._flushing = false;
      } else {
        this._sendQueue = queue.slice(offset);
        socket.once('drain', () => { this._flushing = false; this._flush(); });
      }
    };
    tryFlush();
  }

  _startReadLoop() {
    const socket = this._socket;
    socket.on('data', (chunk) => {
      const frames = this._acc.push(chunk);
      for (const frame of frames) {
        this._onFrame(frame);
      }
    });
  }

  _onFrame(frame) {
    switch (frame.kind) {
      case KIND_CONTROL:
        this._metrics.receivedControl++;
        this.emit('control', frame.payload);
        break;
      case KIND_EVENT:
        this._metrics.receivedEvent++;
        this.emit('event', frame.payload);
        break;
      case KIND_PCM:
        if (frame.direction === DIR_HOST_TO_DEVICE) {
          this._metrics.receivedPcm++;
          this.emit('pcm', frame.payload);
        }
        break;
      case KIND_ARTIFACT:
        this._metrics.receivedArtifact++;
        this.emit('artifact', frame.payload);
        break;
    }
  }

  _startAuth() {
    if (!this._enrollmentSecret) {
      this.emit('authenticated', 0);
      return;
    }
    const socket = this._socket;
    if (!socket) return;
    const originalTimeout = socket.timeout;
    socket.timeout = this.authTimeoutMs;
    const serverNonce = randomBytes(AUTH_NONCE_BYTES);
    try {
      socket.write(AUTH_MAGIC_SERVER_HELLO);
      socket.write(serverNonce);
    } catch (e) {
      socket.destroy();
      this._state = 'disconnected';
      if (this.listenerCount('error') > 0) this.emit('error', 'auth send failed');
      this.emit('state', 'disconnected');
      return;
    }

    const clientNonce = randomBytes(AUTH_NONCE_BYTES);
    const clientProof = authProof(this._enrollmentSecret, AUTH_CLIENT_DOMAIN, serverNonce, clientNonce);
    const clientRecord = Buffer.concat([AUTH_MAGIC_CLIENT_PROOF, clientNonce, clientProof]);

    socket.once('data', (firstChunk) => {
      socket.timeout = originalTimeout;
      try {
        if (!firstChunk || firstChunk.length < 4 + AUTH_NONCE_BYTES + AUTH_PROOF_BYTES) {
          throw new Error('short auth response');
        }
        const magic = firstChunk.subarray(0, 4);
        if (!magic.equals(AUTH_MAGIC_SERVER_PROOF)) {
          this._metrics.authFailures++;
          this._enrollmentSecret.fill(0);
          this._state = 'disconnected';
          this.emit('authentication_failed', 'bad magic');
          return;
        }
        const serverProof = firstChunk.subarray(4, 4 + AUTH_PROOF_BYTES);
        const expectedServerProof = authProof(this._enrollmentSecret, AUTH_SERVER_DOMAIN, serverNonce, clientNonce);
        if (!timingSafeEqual(expectedServerProof, serverProof)) {
          this._metrics.authFailures++;
          this._enrollmentSecret.fill(0);
          this._state = 'disconnected';
          this.emit('authentication_failed', 'proof mismatch');
          return;
        }
        // Session established
        const sessionDigest = authProof(this._enrollmentSecret, AUTH_SESSION_DOMAIN, serverNonce, clientNonce);
        socket.write(sessionDigest);
        socket.flush();
        this._enrollmentSecret.fill(0);
        serverNonce.fill(0);
        clientNonce.fill(0);
        clientProof.fill(0);
        this.emit('authenticated', 1);
      } catch (e) {
        this._state = 'disconnected';
        this.emit('error', e.message);
      }
    });
  }

  _onDisconnect(reason) {
    this.emit('disconnected');
    this.emit('event', JSON.stringify({ event: 'disconnect', reason }).toString());
  }
}
