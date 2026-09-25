// Network bootstrap transport: connects to phone-host:phone-port for the
// X25519 + AES-256-GCM bootstrap handshake, instead of ADB-forwarded loopback.
// Reuses bootstrap-protocol.js identically.

import net from 'node:net';
import {
  BOOTSTRAP_MAX_FRAME_BYTES,
  BOOTSTRAP_PROOF_BYTES,
  encodeClientHello,
} from './bootstrap-protocol.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 27183;
const SERVER_MAGIC = Buffer.from([0x47, 0x32, 0x42, 0x53, 1]);
const CLIENT_MAGIC = Buffer.from([0x47, 0x32, 0x42, 0x43, 1]);
const SERVER_NONCE = Buffer.from('000000000000000000000001', 'hex');
const CLIENT_NONCE = Buffer.from('000000000000000000000002', 'hex');
const SERVER_BODY_BYTES = SERVER_MAGIC.length + 32 + 32 + BOOTSTRAP_PROOF_BYTES + 16;

function frame(body) {
  if (!Buffer.isBuffer(body) || body.length < 1 || body.length > BOOTSTRAP_MAX_FRAME_BYTES) {
    throw new Error('bootstrap frame exceeds 4096 bytes');
  }
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function decodeServerBody(body) {
  if (!Buffer.isBuffer(body) || body.length !== SERVER_BODY_BYTES || !body.subarray(0, 5).equals(SERVER_MAGIC)) {
    throw new Error('bootstrap response is invalid');
  }
  let at = 5;
  const phoneNonce = Buffer.from(body.subarray(at, at + 32)); at += 32;
  const phonePublicKey = Buffer.from(body.subarray(at, at + 32)); at += 32;
  if (!phonePublicKey.some((byte) => byte !== 0)) throw new Error('bootstrap response public key is invalid');
  const ciphertext = Buffer.from(body.subarray(at, at + BOOTSTRAP_PROOF_BYTES)); at += BOOTSTRAP_PROOF_BYTES;
  const tag = Buffer.from(body.subarray(at, at + 16));
  return { phoneNonce, phonePublicKey, proof: { nonce: Buffer.from(SERVER_NONCE), ciphertext, tag } };
}

export class NetworkBootstrapTransport {
  constructor(opts = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('bootstrap timeout is invalid');
    }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  async _open() {
    if (this.socket) return;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      const onError = (error) => { socket.off('connect', onConnect); reject(error); };
      const onConnect = () => { socket.off('error', onError); resolve(); };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  async exchange({ desktopNonce, desktopPublicKey, identity }) {
    await this._open();
    const socket = this.socket;
    const hello = encodeClientHello({ desktopNonce, desktopPublicKey, identity });
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const fail = (error) => {
        cleanup();
        void this.close();
        reject(error);
      };
      const onError = (error) => fail(error);
      const onClose = () => fail(new Error('bootstrap transport closed'));
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length < 4) return;
        const length = this.buffer.readUInt32BE(0);
        if (length < 1 || length > BOOTSTRAP_MAX_FRAME_BYTES) return fail(new Error('bootstrap frame exceeds 4096 bytes'));
        if (this.buffer.length < 4 + length) return;
        if (this.buffer.length !== 4 + length) return fail(new Error('bootstrap response has trailing bytes'));
        const body = Buffer.from(this.buffer.subarray(4));
        this.buffer.fill(0);
        this.buffer = Buffer.alloc(0);
        try {
          const response = decodeServerBody(body);
          body.fill(0);
          cleanup();
          resolve(response);
        } catch (error) {
          body.fill(0);
          fail(error);
        }
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      timer = setTimeout(() => fail(new Error('bootstrap transport timed out')), this.timeoutMs);
      try { socket.write(frame(hello)); } catch (error) { fail(error); }
      finally { hello.fill(0); }
    });
  }

  async confirm({ proof }) {
    if (!this.socket) throw new Error('bootstrap transport is not connected');
    if (!proof || !Buffer.isBuffer(proof.nonce) || !proof.nonce.equals(CLIENT_NONCE)
        || !Buffer.isBuffer(proof.ciphertext) || proof.ciphertext.length !== BOOTSTRAP_PROOF_BYTES
        || !Buffer.isBuffer(proof.tag) || proof.tag.length !== 16) {
      throw new Error('bootstrap client proof is invalid');
    }
    const body = Buffer.concat([CLIENT_MAGIC, proof.ciphertext, proof.tag]);
    try {
      const accepted = this.socket.write(frame(body));
      if (accepted === false && typeof this.socket.once === 'function') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('bootstrap confirm timed out')), this.timeoutMs);
          this.socket.once('drain', () => { clearTimeout(timer); resolve(); });
          this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
      }
    } finally {
      body.fill(0);
    }
  }

  async close() {
    const socket = this.socket;
    this.socket = null;
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
  }
}
