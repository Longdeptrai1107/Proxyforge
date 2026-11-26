import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export function isPublicIP(input) {
  const ip = String(input).toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Accept global unicast only; mapped IPv4, link-local, ULA and transition
  // mechanisms are deliberately excluded from public feeds and proxy probes.
  return family === 6 && /^[23]/.test(ip) &&
    !/^2001:(?:0:|0$|db8:|[01][0-9a-f]:)/.test(ip) && !ip.startsWith('2002:');
}

export function validateFeedURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL nguồn không hợp lệ.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
    (url.port && url.port !== '443') || url.href.length > 2048) {
    throw new Error('Nguồn phải là HTTPS công khai, cổng 443 và không chứa tài khoản.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || (isIP(hostname) && !isPublicIP(hostname))) {
    throw new Error('Không cho phép địa chỉ mạng nội bộ.');
  }
  url.hash = '';
  return url;
}

export async function resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicIP(address))) {
    throw new Error('DNS của nguồn trỏ tới địa chỉ không công khai.');
  }
  return records.find(({ family }) => family === 4) ?? records[0];
}

export async function fetchFeed(value, { signal, timeout = 12000, maxBytes = 4 * 1024 * 1024, redirects = 3 } = {}) {
  const url = validateFeedURL(value);
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
  // DNS is checked and pinned to the actual socket, including every redirect.
  const address = await Promise.race([
    resolvePublic(url.hostname),
    new Promise((_, reject) => {
      if (deadline.aborted) return reject(deadline.reason);
      deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
    }),
  ]);
  deadline.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      signal: deadline,
      agent: false,
      lookup: (_hostname, options, callback) => {
        callback(null, options.all ? [address] : address.address, address.family);
      },
      headers: {
        'User-Agent': 'ProxyForge/1.0 (public-feed-reader)',
        Accept: 'text/plain, application/json, text/html;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.destroy();
        if (!redirects || !res.headers.location) return reject(new Error('Nguồn chuyển hướng quá nhiều.'));
        fetchFeed(new URL(res.headers.location, url).href, {
          signal: deadline, timeout, maxBytes, redirects: redirects - 1,
        }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${status}`));
      }
      let compressed = 0;
      res.on('data', (chunk) => {
        compressed += chunk.length;
        if (compressed > maxBytes) req.destroy(new Error('Nguồn vượt giới hạn 4 MB.'));
      });
      res.on('error', reject);
      const encoding = res.headers['content-encoding'];
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate'
        ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('Nguồn giải nén vượt giới hạn 4 MB.');
          stream.destroy(error);
          req.destroy(error);
        } else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}
