import net from 'node:net';
import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import { BOOTSTRAP_MAX_FRAME_BYTES, BOOTSTRAP_PROOF_BYTES } from './bootstrap-protocol.js';

const CLIENT_MAGIC = Buffer.from('G2B1', 'ascii');
const SERVER_MAGIC = Buffer.from('G2BS\x01', 'binary');
const CLIENT_CONFIRM_MAGIC = Buffer.from('G2BC\x01', 'binary');
const PROOF_TEXT = Buffer.from('agentcall-bootstrap-proof-v1', 'ascii');
const TRANSCRIPT_PREFIX = Buffer.from('agentcall/controller-bootstrap/transcript/v1', 'ascii');
const INFO = Buffer.from('agentcall/controller-bootstrap/v1', 'ascii');
const RAW_X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

function rawPublicKey(key) { return key.export({ format: 'der', type: 'spki' }).subarray(-32); }
function frame(body) { const h = Buffer.alloc(4); h.writeUInt32BE(body.length); return Buffer.concat([h, body]); }
function readText(buf, state) {
  if (state.at + 2 > buf.length) throw new Error('bootstrap text length truncated');
  const n = buf.readUInt16BE(state.at); state.at += 2;
  if (!n || n > 512 || state.at + n > buf.length) throw new Error('bootstrap text invalid');
  const value = buf.subarray(state.at, state.at + n).toString('utf8'); state.at += n;
  if (!value || value.includes('\0')) throw new Error('bootstrap text invalid');
  return value;
}
function decodeHello(body) {
  if (body.length < 72 || !body.subarray(0, 4).equals(CLIENT_MAGIC) || body[4] !== 1 || body[5] !== 1) throw new Error('bootstrap hello invalid');
  if (body[6] !== 0 || body[7] !== 0) throw new Error('bootstrap reserved bits set');
  const desktopNonce = Buffer.from(body.subarray(8, 40));
  const desktopPublicKey = Buffer.from(body.subarray(40, 72));
  const state = { at: 72 };
  const names = ['serial', 'systemFingerprint', 'vendorFingerprint', 'packageName', 'versionCode', 'signingCertificateSha256', 'artifactManifestSha256', 'desktopBootstrapVersion'];
  const identity = Object.fromEntries(names.map((name) => [name, readText(body, state)]));
  if (state.at !== body.length) throw new Error('bootstrap hello trailing bytes');
  return { desktopNonce, desktopPublicKey, identity };
}
function seal(key, nonce, transcript) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(transcript);
  return { ciphertext: Buffer.concat([cipher.update(PROOF_TEXT), cipher.final()]), tag: cipher.getAuthTag() };
}
function open(key, nonce, transcript, ciphertext, tag) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(transcript); decipher.setAuthTag(tag);
  if (!Buffer.concat([decipher.update(ciphertext), decipher.final()]).equals(PROOF_TEXT)) throw new Error('bootstrap proof mismatch');
}

export class NetworkBootstrapServer {
  constructor({ host = '0.0.0.0', port = 27184, onPaired, onError } = {}) {
    if (typeof onPaired !== 'function') throw new TypeError('onPaired is required');
    this.host = host; this.port = port; this.onPaired = onPaired; this.onError = onError ?? (() => {}); this.server = null;
  }
  async start() {
    if (this.server) return;
    const server = net.createServer((socket) => void this._handle(socket)); this.server = server;
    server.on('error', (e) => this.onError(e));
    await new Promise((resolve, reject) => { const fail = (e) => { server.off('listening', ok); reject(e); }; const ok = () => { server.off('error', fail); resolve(); }; server.once('error', fail); server.once('listening', ok); server.listen(this.port, this.host); });
  }
  async _handle(socket) {
    try {
      const body = await readOneFrame(socket); const hello = decodeHello(body);
      const phone = generateKeyPairSync('x25519'); const phonePublicKey = rawPublicKey(phone.publicKey); const phoneNonce = randomBytes(32);
      const transcript = Buffer.concat([TRANSCRIPT_PREFIX, Buffer.from([body.length >> 8, body.length & 255]), body, phoneNonce, phonePublicKey]);
      const peer = createPublicKey({ key: Buffer.concat([RAW_X25519_SPKI, hello.desktopPublicKey]), format: 'der', type: 'spki' });
      const shared = diffieHellman({ privateKey: phone.privateKey, publicKey: peer });
      const salt = Buffer.concat([hello.desktopNonce, phoneNonce]); const info = Buffer.concat([INFO, transcript]);
      const key = Buffer.from(hkdfSync('sha256', shared, salt, info, 32));
      const serverNonce = Buffer.alloc(12); serverNonce[11] = 1; const proof = seal(key, serverNonce, transcript);
      await writeFrame(socket, Buffer.concat([SERVER_MAGIC, phoneNonce, phonePublicKey, proof.ciphertext, proof.tag]));
      const confirm = await readOneFrame(socket); if (!confirm.subarray(0, 5).equals(CLIENT_CONFIRM_MAGIC)) throw new Error('bootstrap confirmation invalid');
      const clientNonce = Buffer.alloc(12); clientNonce[11] = 2; open(key, clientNonce, transcript, confirm.subarray(5, 5 + BOOTSTRAP_PROOF_BYTES), confirm.subarray(5 + BOOTSTRAP_PROOF_BYTES));
      await this.onPaired({ key: Buffer.from(key), identity: hello.identity });
    } catch (error) { this.onError(error); } finally { socket.destroy(); }
  }
  async stop() { const server = this.server; this.server = null; if (server) await new Promise((resolve) => server.close(() => resolve())); }
}
function readOneFrame(socket) { return new Promise((resolve, reject) => { let b = Buffer.alloc(0); const timer = setTimeout(() => fail(new Error('bootstrap timeout')), 30000); const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', fail); socket.off('close', closed); }; const fail = (e) => { cleanup(); reject(e); }; const closed = () => fail(new Error('bootstrap socket closed')); const onData = (c) => { b = Buffer.concat([b, c]); if (b.length < 4) return; const n = b.readUInt32BE(0); if (n < 1 || n > BOOTSTRAP_MAX_FRAME_BYTES) return fail(new Error('bootstrap frame invalid')); if (b.length < n + 4) return; const body = Buffer.from(b.subarray(4, n + 4)); cleanup(); resolve(body); }; socket.on('data', onData); socket.once('error', fail); socket.once('close', closed); }); }
function writeFrame(socket, body) { return new Promise((resolve, reject) => { const ok = socket.write(frame(body), (e) => e ? reject(e) : resolve()); if (!ok) socket.once('error', reject); }); }
