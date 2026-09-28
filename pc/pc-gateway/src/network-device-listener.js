import { createServer } from 'node:net';

/**
 * Accepts one outbound phone connection for the server-side network topology.
 * Authentication and frame handling remain in NetworkDeviceClient.accept().
 */
export class NetworkDeviceListener {
  constructor({ host = '0.0.0.0', port = 27183, createDevice, onDevice, onError } = {}) {
    if (typeof createDevice !== 'function') throw new TypeError('createDevice is required');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port is invalid');
    this.host = host;
    this.port = port;
    this.createDevice = createDevice;
    this.onDevice = onDevice ?? (() => {});
    this.onError = onError ?? (() => {});
    this.server = null;
    this.device = null;
  }

  async start() {
    if (this.server) return;
    const server = createServer((socket) => this._accept(socket));
    this.server = server;
    server.on('error', (error) => this.onError(error));
    await new Promise((resolve, reject) => {
      const onListening = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        server.off('listening', onListening);
        server.off('error', onError);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(this.port, this.host);
    });
  }

  async _accept(socket) {
    if (this.device?.state === 'connected') {
      socket.destroy();
      return;
    }
    const device = this.createDevice();
    try {
      await device.accept(socket);
      this.device = device;
      await this.onDevice(device);
    } catch (error) {
      this.onError(error);
      try { await device.disconnect(); } catch {}
      socket.destroy();
    }
  }

  async stop() {
    const server = this.server;
    this.server = null;
    try { await this.device?.disconnect(); } catch {}
    this.device = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
