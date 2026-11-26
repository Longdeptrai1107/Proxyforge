import { isIP } from 'node:net';
import { isPublicIP } from './network.mjs';

export const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];

export function proxyKey(proxy) {
  return `${proxy.protocol}://${isIP(proxy.host) === 6 ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;
}

const ADDRESS = /(?:(https?|socks[45]):\/\/)?(?:([^\s<>"'@]+)@)?(\[(?:[0-9a-f]*:)+[0-9a-f:.]*\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?!\d)/gi;
const FULL_ADDRESS = /^(?:(https?|socks[45]):\/\/)?(?:([^\s<>"'@]+)@)?(\[(?:[0-9a-f]*:)+[0-9a-f:.]*\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?!\d)$/i;

function decodedBase64(value) {
  if (!/^[a-z0-9+/=_-]{4,128}$/i.test(value)) return null;
  const text = Buffer.from(value + '='.repeat((4 - value.length % 4) % 4), 'base64').toString('utf8');
  return text.length <= 2048 ? text : null;
}

function decodeKnownHTML(input) {
  let text = String(input ?? '');
  const decode = (payload) => decodedBase64(payload);
  text = text.replace(/\bProxy\s*\(\s*(["'])([a-z0-9+/=_-]{8,128})\1\s*\)/gi,
    (whole, _quote, payload) => decode(payload) ?? whole);
  text = text.replace(/document\.write\s*\(\s*atob\(\s*(["'])([a-z0-9+/=_-]{4,128})\1\s*\)\s*\)/gi,
    (whole, _quote, payload) => decode(payload) ?? whole);
  const safeIndex = (expression) => {
    const match = expression.match(/^\s*(\d+)\s*([+-])?\s*(\d+)?\s*$/);
    if (!match) return null;
    return Number(match[1]) + (match[2] === '+' ? Number(match[3]) : match[2] === '-' ? -Number(match[3]) : 0);
  };
  text = text.replace(/document\.write\s*\(\s*(["'])([^"']{1,100})\1\.substring\(\s*([^,()]{1,16})\s*,\s*([^,()]{1,16})\s*\)\.concat\(\s*atob\(\s*(["'])([a-z0-9+/=_-]{4,32})\5\s*\)\s*\)\s*\)/gi,
    (whole, _quote, source, start, end, _payloadQuote, payload) => {
      const first = safeIndex(start);
      const last = safeIndex(end);
      const suffix = decode(payload);
      return first === null || last === null || suffix === null || !/^[\x00-\x7f]*$/.test(suffix)
        ? whole : source.slice(first, last) + suffix;
    });
  text = text.replace(/(["'])([^"']{1,64})\1\.repeat\((\d{1,2})\)\.substring\((\d{1,3})(?:\s*,\s*(\d{1,3}))?\)/g,
    (whole, _quote, value, repeats, start, end) => Number(repeats) <= 16 && Number(start) <= 256 && (!end || Number(end) <= 256)
      ? (value.repeat(Number(repeats))).slice(Number(start), end ? Number(end) : undefined) : whole);
  text = text.replace(/atob\(\s*(["'])([a-z0-9+/=_-]{4,128})\1\s*\)\.concat\(\s*(["'])([^"']{1,64})\3\.split\(["']{2}\)\.reverse\(\)\.join\(["']{2}\)\s*\)/gi,
    (whole, _q1, payload, _q2, suffix) => {
      const decoded = decode(payload);
      return decoded === null ? whole : decoded + [...suffix].reverse().join('');
    });
  text = text.replace(/(["'])([^"']{1,64})\1\.split\(["']{2}\)\.reverse\(\)\.join\(["']{2}\)/g,
    (_whole, _quote, value) => [...value].reverse().join(''));
  text = text.replace(/atob\(\s*(["'])([a-z0-9+/=_-]{4,128})\1\s*\)/gi,
    (whole, _quote, payload) => {
      const decoded = decode(payload);
      return decoded === null ? whole : JSON.stringify(decoded);
    });
  text = text.replace(/\[([\d,\s]{1,512})\]\.map\(\(\s*\w+\s*\)\s*=>\s*String\.fromCharCode\(\s*\w+\s*([+-])\s*(\d+)\s*\)\s*\)\.join\(["']{2}\)/g,
    (whole, values, operator, adjustment) => {
      const codes = [...values.matchAll(/\d+/g)].map(([value]) => Number(value) + (operator === '+' ? Number(adjustment) : -Number(adjustment)));
      return codes.length <= 128 && codes.every((code) => code >= 0 && code <= 127)
        ? codes.map((code) => String.fromCharCode(code)).join('') : whole;
    });
  for (let pass = 0; pass < 8; pass++) {
    const previous = text;
    text = text.replace(/(["'])([^"']{1,128})\1\.substring\(\s*([^,()]{1,16})(?:\s*,\s*([^,()]{1,16}))?\s*\)/g,
      (whole, _quote, value, start, end) => {
        const first = safeIndex(start);
        const last = end ? safeIndex(end) : undefined;
        return first === null || first > 512 || last !== undefined && (last === null || last > 512)
          ? whole : value.slice(first, last);
      });
    text = text.replace(/(["'])([^"']{1,128})\1\.concat\(\s*(["'])([^"']{1,128})\3\s*\)/g,
      (_whole, _q1, left, _q2, right) => left + right);
    if (text === previous) break;
  }
  return text;
}

export function parseProxies(text, defaultProtocol = 'http', { limit = 100000, allowPrivate = false } = {}) {
  const found = new Map();
  text = decodeKnownHTML(text);
  const add = (host, port, protocol = defaultProtocol, metadata) => {
    host = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
    port = Number(port);
    protocol = String(protocol).toLowerCase();
    if (!PROTOCOLS.includes(protocol) || !isIP(host) ||
      (!allowPrivate && !isPublicIP(host)) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const proxy = { host, port, protocol };
    if (metadata) {
      const details = [metadata.ip_data, metadata.connection].find((value) => value && typeof value === 'object') ?? metadata;
      const country = metadata.country_code ?? metadata.countryCode ?? metadata.cc ?? details.countryCode ?? metadata.country;
      if (typeof country === 'string' && /^[a-z]{2}$/i.test(country)) proxy.countryCode = country.toUpperCase();
      for (const [field, value] of Object.entries({ country: metadata.countryName ?? metadata.country_name ?? details.country,
        city: metadata.city ?? details.city, region: metadata.region ?? details.regionName,
        server: metadata.asn_org ?? metadata.server ?? metadata.isp ?? details.isp ?? details.org })) {
        if (typeof value === 'string' && value.trim()) proxy[field] = value.trim().slice(0, 160);
      }
      const asn = String(metadata.asn ?? details.asn ?? details.as ?? '').match(/^(?:AS)?(\d+)\b/i);
      if (asn) proxy.asn = Number(asn[1]);
      if (Object.keys(proxy).length > 3) Object.assign(proxy, { locationSource: 'feed', locationApproximate: true });
    }
    if (found.size < limit) found.set(proxyKey(proxy), { ...found.get(proxyKey(proxy)), ...proxy });
  };
  const trimmed = text.trim();
  let isJSON = false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const stack = [JSON.parse(trimmed)];
      isJSON = true;
      let visited = 0;
      while (stack.length && found.size < limit && visited++ < 400000) {
        const value = stack.pop();
        if (typeof value === 'string') {
          for (const match of value.matchAll(ADDRESS)) if (!match[2]) add(match[3], match[4], match[1] ?? defaultProtocol);
          continue;
        }
        if (!value || typeof value !== 'object') continue;
        const host = value.ip ?? value.host ?? value.ipAddress ?? value.ip_address ?? value.addr;
        if (host && value.port && !value.username && !value.password) {
          const protocols = value.protocols ?? [value.protocol ?? value.proxy_type ?? value.scheme ?? value.type ?? defaultProtocol];
          for (const protocol of Array.isArray(protocols) ? protocols : [protocols]) add(host, value.port, protocol, value);
        }
        for (const child of Object.values(value)) if (child && (typeof child === 'object' || typeof child === 'string' && !(host && value.port))) stack.push(child);
      }
    } catch { /* Text and HTML extraction still apply to malformed JSON. */ }
  }
  // Consume credentials as part of the match so credentialed entries are skipped,
  // rather than silently exporting them without the credentials they require.
  const pattern = /(?:(https?|socks[45]):\/\/)?(?:([^\s<>"'@]+)@)?(\[(?:[0-9a-f]*:)+[0-9a-f:.]*\]|(?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?!\d)/gi;
  let match;
  const plainText = isJSON ? '' : text.replace(/<(tr|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_whole, body) => FULL_ADDRESS.test(body.trim()) ? body : '');
  while (found.size < limit && (match = pattern.exec(plainText))) {
    if (!match[2]) add(match[3], match[4], match[1] ?? defaultProtocol);
  }

  const xorValues = new Map();
  const assignments = [...text.matchAll(/\b([a-z_]\w*)\s*=\s*(\d+)\s*(?:\^\s*([a-z_]\w*))?\s*;/gi)];
  for (let pass = 0; pass < assignments.length; pass++) {
    let changed = false;
    for (const [, name, number, other] of assignments) {
      if (other && !xorValues.has(other.toLowerCase())) continue;
      const value = Number(number) ^ (other ? xorValues.get(other.toLowerCase()) : 0);
      if (xorValues.get(name.toLowerCase()) !== value) {
        xorValues.set(name.toLowerCase(), value);
        changed = true;
      }
    }
    if (!changed) break;
  }

  if (found.size < limit && /<tr\b/i.test(text)) {
    const rows = text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    for (const row of rows) {
      if (found.size >= limit) break;
      const cellMarkup = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
      const cells = cellMarkup.map((cell) => cell.replace(/<[^>]*>/g, '').trim());
      const advertised = row.match(/\bdata-protos\s*=\s*(["'])(.*?)\1/i);
      let protocols = advertised
        ? advertised[2].toLowerCase().split(/[^a-z0-9]+/).filter((value) => PROTOCOLS.includes(value)) : [];
      if (!protocols.length) {
        const visible = row.replace(/<[^>]*>/g, ' ');
        protocols = PROTOCOLS.filter((value) => new RegExp(`\\b${value}\\b`, 'i').test(visible));
      }
      if (!protocols.length) protocols = [defaultProtocol];

      for (const [, _quote, payload] of row.matchAll(/\bdata-p\s*=\s*(["'])([a-z0-9+/=_-]{12,128})\1/gi)) {
        const address = decodedBase64(payload)?.split('').reverse().join('');
        const decoded = address?.match(FULL_ADDRESS);
        if (decoded && !decoded[2]) for (const protocol of protocols) add(decoded[3], decoded[4], decoded[1] ?? protocol);
      }

      if (cells[0] && xorValues.size) {
        const firstIP = cells[0].match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/);
        if (firstIP) {
          const script = [...(cellMarkup[0].matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))].map((item) => item[1]).join(' ');
          const digits = [...script.matchAll(/\(([a-z_]\w*)\s*\^\s*([a-z_]\w*)\)/gi)]
            .filter(([, left, right]) => xorValues.has(left.toLowerCase()) && xorValues.has(right.toLowerCase()))
            .map(([, left, right]) => String(xorValues.get(left.toLowerCase()) ^ xorValues.get(right.toLowerCase())))
            .join('');
          if (/^\d{1,5}$/.test(digits)) for (const protocol of protocols) add(firstIP[0], digits, protocol);
        }
      }

      for (let i = 0; i < cells.length; i++) {
        for (const address of cells[i].matchAll(ADDRESS)) {
          if (!address[2]) for (const protocol of protocols) add(address[3], address[4], address[1] ?? protocol);
        }
        const host = isIP(cells[i]) ? cells[i] : cells[i].match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/)?.[0];
        if (i + 1 < cells.length && host && /^\d{1,5}$/.test(cells[i + 1])) {
          for (const protocol of protocols) add(host, cells[i + 1], protocol);
        }
      }
    }
  }
  return [...found.values()];
}
