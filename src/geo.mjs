import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { isIP } from 'node:net';

function numericIP(host) {
  if (isIP(host) === 4) return host.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  if (host.includes('.')) host = host.replace(/\d+\.\d+\.\d+\.\d+$/, (ipv4) => {
    const number = numericIP(ipv4); return `${Math.floor(number / 65536).toString(16)}:${(number % 65536).toString(16)}`;
  });
  const halves = host.split('::').map((half) => half ? half.split(':') : []);
  const groups = halves.length === 2 ? [...halves[0], ...Array(8 - halves[0].length - halves[1].length).fill('0'), ...halves[1]] : halves[0];
  return groups.reduce((value, group) => value * 65536n + BigInt('0x' + group), 0n);
}

export class GeoLookup {
  constructor(directory) { this.directory = join(directory, 'geo'); this.tables = new Map(); this.countries = new Map(); this.warning = null; this.loadedAt = 0; }
  async prepare() {
    if (this.loadedAt && Date.now() - this.loadedAt < 7 * 86400000) return;
    if (!this.loading) this.loading = this.load().catch((error) => {
      this.warning = `Chưa tải được dữ liệu vị trí/ASN: ${error.message}`;
    }).finally(() => { this.loading = null; });
    await this.loading;
  }
  async lines(path, consume) {
    const file = createReadStream(path);
    const input = createGunzip();
    file.on('error', (error) => input.destroy(error));
    file.pipe(input);
    const lines = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of lines) {
        consume(line);
        if (++count % 4096 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally { lines.close(); file.destroy(); input.destroy(); }
    if (!count) throw new Error('Empty IP database');
  }
  async read(path, version) {
    const starts = [], ends = [], values = [], networks = new Map();
    await this.lines(path, (line) => {
      const [start, end, asn, country, server] = line.split('\t');
      if (server === undefined) throw new Error('Invalid ASN database');
      starts.push(version === 4 ? Number(start) : numericIP(start));
      ends.push(version === 4 ? Number(end) : numericIP(end));
      if (starts.at(-1) > ends.at(-1) || starts.length > 1 && starts.at(-1) <= ends.at(-2)) throw new Error('Invalid ASN ranges');
      const key = `${asn}:${country}`;
      if (!networks.has(key)) networks.set(key, { asn: Number(asn) || null,
        server: Number(asn) ? server : null, countryCode: /^[A-Z]{2}$/.test(country) && country !== 'ZZ' ? country : null,
        locationSource: 'IPtoASN (ASN registration)', locationApproximate: true });
      values.push(networks.get(key));
    });
    return { starts, ends, values };
  }
  async readCountries(path) {
    const tables = new Map([[4, { starts: [], ends: [], values: [] }], [6, { starts: [], ends: [], values: [] }]]);
    await this.lines(path, (line) => {
      const [start, end, country] = line.split(',').map((field) => field.replace(/^"|"$/g, ''));
      const version = isIP(start), table = tables.get(version);
      if (!table || isIP(end) !== version || !/^[A-Z]{2}$/.test(country)) throw new Error('Invalid country database');
      const first = numericIP(start), last = numericIP(end);
      if (first > last || table.starts.length && first <= table.ends.at(-1)) throw new Error('Invalid country ranges');
      table.starts.push(first); table.ends.push(last); table.values.push(country);
    });
    if (!tables.get(4).starts.length || !tables.get(6).starts.length) throw new Error('Empty country database');
    return tables;
  }
  async cached(path, url, read, maxAge) {
    const cached = await stat(path).catch(() => null);
    if (!cached || Date.now() - cached.mtimeMs > maxAge) {
      const temporary = path + '.download';
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 32 * 1024 * 1024 ? new Error('IP database exceeds 32 MB') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary));
        const table = await read(temporary);
        await rename(temporary, path);
        return table;
      } catch (error) {
        await unlink(temporary).catch(() => {});
        if (!cached) throw error;
      }
    }
    return read(path);
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    const tables = new Map(), warnings = [];
    for (const [version, filename] of [[4, 'ip2asn-v4-u32.tsv.gz'], [6, 'ip2asn-v6.tsv.gz']]) {
      try { tables.set(version, await this.cached(join(this.directory, filename), `https://iptoasn.com/data/${filename}`,
        (path) => this.read(path, version), 7 * 86400000)); }
      catch (error) { warnings.push(`ASN IPv${version}: ${error.message}`); }
    }
    if (tables.size) this.tables = tables;
    const filename = `dbip-country-lite-${new Date().toISOString().slice(0, 7)}.csv.gz`;
    try { this.countries = await this.cached(join(this.directory, filename), `https://download.db-ip.com/free/${filename}`,
      (path) => this.readCountries(path), 32 * 86400000); }
    catch (error) {
      warnings.push(`Quốc gia DB-IP: ${error.message}`);
      for (const cached of (await readdir(this.directory)).filter((name) => /^dbip-country-lite-.*\.csv\.gz$/.test(name)).sort().reverse()) {
        try { this.countries = await this.readCountries(join(this.directory, cached)); break; } catch { /* Try a previous cached release. */ }
      }
    }
    this.warning = warnings.join('; ') || null;
    if (this.tables.size || this.countries.size) this.loadedAt = Date.now();
  }
  lookup(host) {
    const result = { asn: null, server: null, countryCode: null, locationSource: null, locationApproximate: true };
    const version = isIP(host);
    if (!version) return result;
    const address = numericIP(host);
    const find = (table) => {
      if (!table) return null;
      let low = 0, high = table.starts.length;
      while (low < high) { const middle = (low + high) >>> 1; if (table.starts[middle] <= address) low = middle + 1; else high = middle; }
      const index = low - 1;
      return index >= 0 && address <= table.ends[index] ? table.values[index] : null;
    };
    Object.assign(result, find(this.tables.get(version)));
    const country = find(this.countries.get(version));
    if (country && !['ZZ', 'XX'].includes(country)) Object.assign(result, { countryCode: country, locationSource: 'DB-IP Lite' });
    return result;
  }
}
