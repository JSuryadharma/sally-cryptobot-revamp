// Minimal hand-rolled WebSocket server (RFC 6455) - no "ws" dependency, so
// robocrypto installs with zero npm packages. Text frames only (JSON
// messages out, ping/pong/close handled), same broadcast pattern as
// robotrader: one WebSocketHub instance, other modules call hub.broadcast(msg).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketHub {
  constructor(server) {
    this.clients = new Set();
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));
    this.clients.add(socket);
    socket.on('data', (buffer) => this.handleFrame(socket, buffer));
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  handleFrame(socket, buffer) {
    try {
      const opcode = buffer[0] & 0x0f;
      if (opcode === 0x8) { socket.end(); this.clients.delete(socket); return; } // close
      if (opcode === 0x9) { this.sendFrame(socket, Buffer.alloc(0), 0xA); return; } // ping -> pong
      // Ignore incoming text/binary frames - this app only pushes server->client.
    } catch {
      // Malformed frame from a client - drop the connection rather than crash the server.
      socket.destroy();
      this.clients.delete(socket);
    }
  }

  sendFrame(socket, payload, opcode = 0x1) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      this.clients.delete(socket);
    }
  }

  broadcast(message) {
    const payload = Buffer.from(JSON.stringify(message));
    for (const socket of this.clients) this.sendFrame(socket, payload);
  }
}
