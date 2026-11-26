import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { GeoLookup } from '../src/geo.mjs';

test('cached IPv4/IPv6 lookups use IP country in preference to ASN registration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxyforge-geo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const geo = new GeoLookup(directory);
  await mkdir(geo.directory);
  const files = {
    'ip2asn-v4-u32.tsv.gz': '134744064\t134744319\t15169\tUS\tGoogle\n',
    'ip2asn-v6.tsv.gz': '2606:4700::\t2606:4700::ffff\t13335\tUS\tCloudflare\n',
    [`dbip-country-lite-${new Date().toISOString().slice(0, 7)}.csv.gz`]: '"8.8.8.0","8.8.8.255","VN"\n"2606:4700::","2606:4700::ffff","DE"\n',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(geo.directory, name), gzipSync(text));
  await geo.prepare();
  assert.equal(geo.warning, null);
  for (const address of ['8.8.8.0', '8.8.8.8', '8.8.8.255']) {
    assert.equal(geo.lookup(address).countryCode, 'VN');
    assert.equal(geo.lookup(address).server, 'Google');
    assert.equal(geo.lookup(address).locationSource, 'DB-IP Lite');
  }
  assert.equal(geo.lookup('2606:4700::ffff').countryCode, 'DE');
  assert.equal(geo.lookup('8.8.9.0').countryCode, null);
  assert.equal(geo.lookup('invalid').asn, null);
});

test('a corrupt database download leaves the cached file usable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxyforge-geo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const geo = new GeoLookup(directory);
  const path = join(directory, 'asn.gz');
  const original = gzipSync('134744064\t134744319\t15169\tUS\tGoogle\n');
  await writeFile(path, original);
  await utimes(path, 0, 0);
  t.mock.method(globalThis, 'fetch', async () => new Response(gzipSync('134744064\t134744319\t15169\tUS\tGoogle\nbad row\n')));
  const table = await geo.cached(path, 'https://example.com/data', (file) => geo.read(file, 4), 1);
  assert.deepEqual(await readFile(path), original);
  assert.equal(table.values[0].server, 'Google');
});
