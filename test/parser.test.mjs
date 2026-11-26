import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxies, proxyKey } from '../src/parse.mjs';
import { SOURCES } from '../src/sources.mjs';

test('parses JSON and ordinary proxy rows', () => {
  assert.equal(parseProxies('{"data":[{"ip":"8.8.8.8","port":8080,"protocol":"http"}]}').length, 1);
  assert.equal(parseProxies('<tr><td>8.8.8.8</td><td>8080</td></tr>')[0].port, 8080);
});

test('decodes public website formats without evaluating their JavaScript', () => {
  const encodedPair = Buffer.from('8.8.8.8:8080').toString('base64');
  const encodedIP = Buffer.from('8.8.8.8').toString('base64');
  const encodedReverse = Buffer.from('0808:8.8.8.8').toString('base64');
  const html = `<script>Proxy('${encodedPair}')</script>
    <table>
      <tr><td><script>document.write(atob("${encodedIP}"))</script></td><td>8081</td></tr>
      <tr data-protos="HTTP|SOCKS5"><td>46.232.249.209:40001</td><td>proxy</td></tr>
      <tr><td><span>8.8.4.4</span><span>:8082</span></td><td>HTTP</td></tr>
      <tr data-p="${encodedReverse}"><td></td><td>HTTP</td></tr>
      <tr><td>1.1.1.1<script>document.write((y^x)+(y^x)+(y^x)+(w^z))</script></td><td>HTTP</td></tr>
    </table><script>x=9;y=9^x;z=2;w=0^z;</script>`;
  const keys = new Set(parseProxies(html).map(proxyKey));
  assert(keys.has('http://8.8.8.8:8080'));
  assert(keys.has('http://8.8.8.8:8081'));
  assert(keys.has('http://8.8.4.4:8082'));
  assert(keys.has('http://1.1.1.1:9990'));
  assert(keys.has('socks5://46.232.249.209:40001'));
});

test('catalog has fifty independent, non-GitHub websites and all four protocols', () => {
  const domains = new Set(SOURCES.map(({ url }) => new URL(url).hostname));
  assert.equal(SOURCES.length, 50);
  assert.equal(domains.size, 50);
  assert.equal(new Set(SOURCES.map(({ publisher }) => publisher)).size, 50);
  const feeds = SOURCES.flatMap((source) => source.feeds ?? [source]);
  assert(feeds.every(({ url }) => url.startsWith('https://') && !url.toLowerCase().includes('github')));
  assert.deepEqual(new Set(feeds.map(({ protocol }) => protocol)), new Set(['http', 'https', 'socks4', 'socks5']));
});

test('structured protocols and location are preserved without bogus HTTP duplicates', () => {
  const parsed = parseProxies(JSON.stringify({ proxies: [{ ip: '8.8.8.8', port: 1080,
    proxy: '8.8.8.8:1080', protocol: 'socks5', ip_data: { countryCode: 'VN', city: 'Hanoi', as: 'AS7552 Viettel', isp: 'Viettel' } }] }));
  assert.deepEqual(parsed.map(proxyKey), ['socks5://8.8.8.8:1080']);
  assert.equal(parsed[0].countryCode, 'VN');
  assert.equal(parsed[0].server, 'Viettel');
  assert.equal(parsed[0].city, 'Hanoi');
  assert.equal(parsed[0].asn, 7552);
  assert.equal(parseProxies(JSON.stringify(parsed))[0].server, 'Viettel');
  assert.deepEqual(parseProxies('<tr><td>8.8.8.8:1080</td><td>SOCKS5</td></tr>').map(proxyKey), ['socks5://8.8.8.8:1080']);
  assert.equal(parseProxies('["https://8.8.8.8:443"]')[0].protocol, 'https');
});

test('provider field variants retain protocol and skip documentation code examples', () => {
  const records = [{ ip_address: '8.8.8.8', port: 1080, protocol: 'SOCKS5', proxy: '8.8.8.8:1080' },
    { addr: '1.1.1.1', port: 4145, protocol: 'socks4', country_code: 'DE' },
    { host: '9.9.9.9', port: 3128, proxy_type: 'HTTP', cc: 'US' },
    { ip: '8.8.4.4', port: 1081, scheme: 'socks5', cc: 'VN' }];
  const parsed = parseProxies(JSON.stringify({ proxies: records }));
  assert.deepEqual(new Set(parsed.map(proxyKey)), new Set(['socks5://8.8.8.8:1080', 'socks4://1.1.1.1:4145', 'http://9.9.9.9:3128', 'socks5://8.8.4.4:1081']));
  assert.equal(parsed.find(({ host }) => host === '8.8.4.4').countryCode, 'VN');
  const html = '<pre>http://1.2.3.4:8080</pre><code>socks5://1.2.3.4:1080</code>' +
    '<script>self.__next_f.push([1,"example http://1.2.3.4:8080"])</script><tr><td>8.8.8.8</td><td>8080</td></tr>';
  assert.deepEqual(parseProxies(html).map(proxyKey), ['http://8.8.8.8:8080']);
  const codes = [...'8.8.4.4'].map((char) => char.charCodeAt(0) + 1).join(',');
  assert.deepEqual(parseProxies(`<tr><td><script>[${codes}].map((n)=>String.fromCharCode(n-1)).join("")</script></td><td>8080</td></tr>`).map(proxyKey), ['http://8.8.4.4:8080']);
});
