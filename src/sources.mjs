import { readFileSync } from 'node:fs';

// Keep Python, WinForms and the optional Node server on the same verified
// website catalog.
export const SOURCES = JSON.parse(
  readFileSync(new URL('../proxyforge/sources.json', import.meta.url), 'utf8'),
);
