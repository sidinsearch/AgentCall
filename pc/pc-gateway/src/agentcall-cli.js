#!/usr/bin/env node

// AgentCall CLI — network/USB mode control without the desktop app.
// Works as a standalone tool or as an MCP-compatible stdio server.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socket as netSocket } from 'node:net';
import { E164_RE } from './runtime-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTROLLER_SECRET_FILE = join(__dirname, '..', '..', 'var', 'lib', 'agentcall', 'controller', 'controller.key');
const REDACTION_SALT_FILE = join(__dirname, '..', '..', 'var', 'lib', 'agentcall', 'redaction-salt');

// ---- minimal RPC client over Unix socket ----

async function rpcCall(socketPath, method, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = netSocket.createConnection(socketPath);
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('rpc timeout')); }, 30_000);
    socket.on('connect', () => {
      const request = JSON.stringify({ jsonrpc: '2024-11-05', method, params: args, id: createHash('sha256').update(randomBytes(16).toString('hex')).digest('hex').slice(0, 16) });
      socket.write(request + '\n');
    });
    socket.on('data', (chunk) => {
      clearTimeout(timeout);
      const text = chunk.toString('utf8');
      try {
        const response = JSON.parse(text);
        if (response.error) reject(new Error(response.error.message ?? 'rpc error'));
        else resolve(response.result);
      } catch {
        // partial read; accumulate
      }
    });
    socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    socket.on('close', () => { clearTimeout(timeout); reject(new Error('rpc connection closed')); });
  });
}

// ---- CLI commands ----

async function cmdStatus(socketPath) {
  const result = await rpcCall(socketPath, 'status');
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCapabilities(socketPath) {
  const result = await rpcCall(socketPath, 'capabilities');
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDial(socketPath, destination, consentPolicy) {
  if (!E164_RE.test(destination)) {
    console.error('Error: destination must be a valid E.164 number (e.g. +919876543210)');
    process.exit(1);
  }
  const result = await rpcCall(socketPath, 'dial', {
    approved: true,
    consent: { recorded: true, policy: consentPolicy ?? 'CLI dial consent' },
    destination,
    openingText: 'Hello, this is AgentCall. Can you hear me clearly?',
    preparedReplies: ['Yes, I can hear you clearly.', 'The audio sounds good.'],
    idempotencyKey: `cli-dial-${Date.now()}`,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAnswer(socketPath, callId) {
  const result = await rpcCall(socketPath, 'answer', { callId, idempotencyKey: `cli-answer-${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdReject(socketPath, callId) {
  const result = await rpcCall(socketPath, 'reject', { callId, idempotencyKey: `cli-reject-${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdHangup(socketPath, callId) {
  const result = await rpcCall(socketPath, 'hangup', { callId, idempotencyKey: `cli-hangup-${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSendDtmf(socketPath, callId, digits) {
  const result = await rpcCall(socketPath, 'send_dtmf', { callId, digits, idempotencyKey: `cli-dtmf-${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSpeak(socketPath, callId, text) {
  const result = await rpcCall(socketPath, 'speak', { callId, text, idempotencyKey: `cli-speak-${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSetupNetwork(socketPath, phoneHost, phonePort) {
  console.log('AgentCall network mode setup');
  console.log('============================');
  console.log('');
  console.log('Phone host: ' + phoneHost);
  console.log('Phone port: ' + (phonePort ?? 27183));
  console.log('');
  console.log('Required environment variables for network mode:');
  console.log('  AGENTCALL_MODE=network');
  console.log('  AGENTCALL_PHONE_HOST=' + phoneHost);
  console.log('  AGENTCALL_PHONE_PORT=' + (phonePort ?? 27183));
  console.log('  AGENTCALL_CONTROLLER_SECRET_FILE=' + CONTROLLER_SECRET_FILE);
  console.log('');
  console.log('The phone must be running AgentCall v1.0.1+ with network listener enabled.');
  console.log('Use the desktop app or this CLI to pair the first time.');
}

async function cmdGenerateSecret() {
  const secret = randomBytes(32);
  const dir = dirname(CONTROLLER_SECRET_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CONTROLLER_SECRET_FILE, secret, { mode: 0o640 });
  const encoded = secret.toString('hex');
  secret.fill(0);
  console.log('Controller secret generated at: ' + CONTROLLER_SECRET_FILE);
  console.log('Secret (hex, for phone pairing): ' + encoded);
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('AgentCall CLI — usage:');
    console.log('');
    console.log('  agentcall-cli status                      — gateway and phone status');
    console.log('  agentcall-cli capabilities                — available tools');
    console.log('  agentcall-cli dial <E.164> [policy]       — place outgoing call');
    console.log('  agentcall-cli answer <callId>             — answer incoming call');
    console.log('  agentcall-cli reject <callId>             — reject incoming call');
    console.log('  agentcall-cli hangup <callId>             — hang up active call');
    console.log('  agentcall-cli send-dtmf <callId> <digits> — send DTMF tones');
    console.log('  agentcall-cli speak <callId> <text>       — speak text during call');
    console.log('  agentcall-cli setup-network <host> [port] — configure network mode');
    console.log('  agentcall-cli generate-secret             — generate controller secret');
    console.log('');
    console.log('Environment:');
    console.log('  AGENTCALL_RPC_SOCKET (default: /run/agentcall/gatewayd.sock)');
    console.log('');
    process.exit(0);
  }

  const socketPath = process.env.AGENTCALL_RPC_SOCKET ?? '/run/agentcall/gatewayd.sock';
  const command = args[0];

  try {
    switch (command) {
      case 'status':
        await cmdStatus(socketPath);
        break;
      case 'capabilities':
        await cmdCapabilities(socketPath);
        break;
      case 'dial':
        if (args.length < 2) { console.error('Usage: agentcall-cli dial <E.164> [policy]'); process.exit(1); }
        await cmdDial(socketPath, args[1], args[2]);
        break;
      case 'answer':
        if (args.length < 2) { console.error('Usage: agentcall-cli answer <callId>'); process.exit(1); }
        await cmdAnswer(socketPath, args[1]);
        break;
      case 'reject':
        if (args.length < 2) { console.error('Usage: agentcall-cli reject <callId>'); process.exit(1); }
        await cmdReject(socketPath, args[1]);
        break;
      case 'hangup':
        if (args.length < 2) { console.error('Usage: agentcall-cli hangup <callId>'); process.exit(1); }
        await cmdHangup(socketPath, args[1]);
        break;
      case 'send-dtmf':
        if (args.length < 3) { console.error('Usage: agentcall-cli send-dtmf <callId> <digits>'); process.exit(1); }
        await cmdSendDtmf(socketPath, args[1], args[2]);
        break;
      case 'speak':
        if (args.length < 3) { console.error('Usage: agentcall-cli speak <callId> <text>'); process.exit(1); }
        await cmdSpeak(socketPath, args[1], args.slice(2).join(' '));
        break;
      case 'setup-network':
        if (args.length < 2) { console.error('Usage: agentcall-cli setup-network <host> [port]'); process.exit(1); }
        await cmdSetupNetwork(socketPath, args[1], args[2]);
        break;
      case 'generate-secret':
        await cmdGenerateSecret();
        break;
      default:
        console.error('Unknown command: ' + command);
        process.exit(1);
    }
  } catch (error) {
    console.error('Error: ' + error.message);
    process.exit(1);
  }
}

main();
