import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkDeviceListener } from '../src/network-device-listener.js';

test('NetworkDeviceListener validates server configuration', () => {
  assert.throws(() => new NetworkDeviceListener({ port: 70000, createDevice() {} }), /port is invalid/);
  assert.throws(() => new NetworkDeviceListener({ port: 27183 }), /createDevice is required/);
});

test('NetworkDeviceListener starts and stops a TCP listener', async () => {
  const listener = new NetworkDeviceListener({
    host: '127.0.0.1',
    port: 0,
    createDevice() { return { state: 'disconnected', disconnect: async () => {} }; },
  });
  // Port zero is useful for isolated tests, while production uses 27183.
  await listener.start();
  assert.ok(listener.server);
  await listener.stop();
  assert.equal(listener.server, null);
});
