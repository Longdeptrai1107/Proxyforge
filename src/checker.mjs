import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { isPublicIP } from './network.mjs';

// IPLocate documents this IP echo endpoint as free with no rate limit.
// A private deployment can set CHECK_URL to its own HTTPS IP echo server.
export const CHECK_URL = process.env.CHECK_URL ?? 'https://api.iplocate.io/ip';
const MAX_HANDSHAKE = 16384;

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.error = null;
    this.pending = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_HANDSHAKE) this.fail(new Error('Phản hồi bắt tay quá lớn.'));
      this.flush();
    };
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error('Proxy đóng kết nối sớm.'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onClose);
    socket.on('close', this.onClose);
  }
  fail(error) {
    this.error ??= error;
    this.flush();
  }
  flush() {
    if (!this.pending) return;
    const { predicate, resolve, reject } = this.pending;
    if (this.error) {
      this.pending = null;
      reject(this.error);
      return;
    }
    const length = predicate(this.buffer);
    if (length !== null) {
      this.pending = null;
      const result = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      resolve(result);
    }
  }
  read(predicate) {
    return new Promise((resolve, reject) => {
      this.pending = { predicate, resolve, reject };
      this.flush();
    });
  }
  bytes(count) { return this.read((buffer) => buffer.length >= count ? count : null); }
  headers() {
    return this.read((buffer) => {
      const end = buffer.indexOf('\r\n\r\n');
      return end < 0 ? null : end + 4;
    });
  }
  release() {
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('end', this.onClose);
    this.socket.off('close', this.onClose);
    if (this.buffer.length) this.socket.unshift(this.buffer);
  }
}

function connect(proxy, register) {
  return new Promise((resolve, reject) => {
    const secure = proxy.protocol === 'https';
    const options = { host: proxy.host, port: proxy.port, family: net.isIP(proxy.host) };
    const socket = register(secure ? tls.connect({ ...options, rejectUnauthorized: true }) : net.connect(options));
    socket.setNoDelay(true);
    const event = secure ? 'secureConnect' : 'connect';
    const onError = (error) => reject(error);
    socket.once('error', onError);
    socket.once(event, () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

async function handshake(proxy, socket, target) {
  const reader = new SocketReader(socket);
  const port = Number(target.port || 443);
  try {
    if (proxy.protocol === 'http' || proxy.protocol === 'https') {
      const authority = `${target.hostname}:${port}`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: ProxyForge/1.0\r\n\r\n`);
      const response = (await reader.headers()).toString('latin1');
      if (!/^HTTP\/1\.[01] 200(?:\s|\r)/.test(response)) {
        throw new Error(`CONNECT bị từ chối: ${response.split('\r\n')[0].slice(0, 90)}`);
      }
    } else if (proxy.protocol === 'socks5') {
      socket.write(Buffer.from([5, 1, 0]));
      const auth = await reader.bytes(2);
      if (auth[0] !== 5 || auth[1] !== 0) throw new Error('SOCKS5 yêu cầu xác thực hoặc sai giao thức.');
      const domain = Buffer.from(target.hostname, 'ascii');
      if (domain.length > 255) throw new Error('Tên miền đích quá dài.');
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([port >> 8, port & 255]),
      ]));
      const reply = await reader.bytes(4);
      if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error(`SOCKS5 từ chối kết nối (${reply[1]}).`);
      if (reply[3] === 1) await reader.bytes(6);
      else if (reply[3] === 4) await reader.bytes(18);
      else if (reply[3] === 3) {
        const size = (await reader.bytes(1))[0];
        await reader.bytes(size + 2);
      } else throw new Error('SOCKS5 trả địa chỉ không hợp lệ.');
    } else if (proxy.protocol === 'socks4') {
      // SOCKS4a delegates target DNS to the proxy, avoiding a DNS lookup per probe.
      socket.write(Buffer.concat([
        Buffer.from([4, 1, port >> 8, port & 255, 0, 0, 0, 1, 0]),
        Buffer.from(target.hostname, 'ascii'), Buffer.from([0]),
      ]));
      const reply = await reader.bytes(8);
      if (![0, 4].includes(reply[0]) || reply[1] !== 90) throw new Error(`SOCKS4 từ chối kết nối (${reply[1]}).`);
    } else throw new Error('Giao thức không được hỗ trợ.');
  } finally { reader.release(); }
}

function fetchThroughTunnel(socket, target, register) {
  return new Promise((resolve, reject) => {
    const secure = register(tls.connect({
      socket,
      servername: target.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    }));
    secure.once('error', reject);
    secure.once('secureConnect', () => {
      // The custom agent can only return this established tunnel. There is no
      // path that opens a direct connection when a proxy fails.
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => secure;
      const request = https.get(target, {
        agent,
        headers: {
          'User-Agent': 'ProxyForge/1.0', Accept: 'text/plain, application/json',
          'Accept-Encoding': 'identity', Connection: 'close',
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy(new Error('Phản hồi kiểm tra vượt 64 KB.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('Phản hồi HTTPS chưa hoàn tất.')));
        response.on('end', () => {
          agent.destroy();
          if (response.statusCode !== 200) return reject(new Error(`Đích kiểm tra trả HTTP ${response.statusCode}.`));
          const body = Buffer.concat(chunks).toString('utf8').trim();
          let exitIP = net.isIP(body) ? body : null;
          if (!exitIP) {
            try {
              const json = JSON.parse(body);
              const candidate = json.ip ?? json.origin?.split(',')[0]?.trim();
              if (net.isIP(candidate)) exitIP = candidate;
            } catch { /* A valid IP echo body is required. */ }
          }
          if (!exitIP) return reject(new Error('Đích kiểm tra không trả IP hợp lệ.'));
          resolve({ exitIP, bytes });
        });
      });
      request.on('error', reject);
      secure.resume();
    });
    socket.resume();
  });
}

export async function checkProxy(proxy, {
  mode = 'https', timeoutMs = 3000, signal, targetURL = CHECK_URL, allowPrivate = false,
} = {}) {
  const started = performance.now();
  const sockets = new Set();
  let timer;
  let onAbort;
  try {
    if (!net.isIP(proxy.host) || (!allowPrivate && !isPublicIP(proxy.host))) throw new Error('IP proxy không công khai.');
    const target = new URL(targetURL);
    if (target.protocol !== 'https:') throw new Error('Đích kiểm tra phải dùng HTTPS.');
    const register = (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      return socket;
    };
    const cancelled = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Quá thời gian ${timeoutMs} ms.`);
        error.code = 'ETIMEDOUT';
        for (const socket of sockets) socket.destroy(error);
        reject(error);
      }, timeoutMs);
      onAbort = () => {
        const error = new Error('Đã dừng kiểm tra.');
        error.code = 'ABORT_ERR';
        for (const socket of sockets) socket.destroy(error);
        reject(error);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    const probe = async () => {
      signal?.throwIfAborted();
      const socket = await connect(proxy, register);
      const connectMs = Math.round(performance.now() - started);
      await handshake(proxy, socket, target);
      const handshakeMs = Math.round(performance.now() - started);
      const result = mode === 'https' ? await fetchThroughTunnel(socket, target, register) : {};
      return {
        status: mode === 'https' ? 'alive' : 'handshake',
        latencyMs: Math.round(performance.now() - started), connectMs, handshakeMs,
        ...result, checkedAt: new Date().toISOString(), error: null,
      };
    };
    return await Promise.race([probe(), cancelled]);
  } catch (error) {
    return {
      status: error.code === 'ABORT_ERR' || signal?.aborted ? 'cancelled' : 'dead',
      latencyMs: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(), error: String(error.message).slice(0, 180),
    };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    for (const socket of sockets) socket.destroy();
  }
}
