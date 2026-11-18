import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('settings opens the fixed game folder through preload without supplying a path', async () => {
  const source = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
  assert.match(source, /window\.kayvel\.openGameFolder\(lang\)/);
  assert.match(source, /className="open-game-folder" disabled=\{!status \|\| openingFolder\}/);
  assert.match(source, /'Открыть папку' : 'Open folder'/);
  assert.match(source, /<p role="status">\{folderMessage\}<\/p>/);
});

test('installed NeoForge status uses a plain label and retains actual readiness', async () => {
  const source = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
  assert.match(source, /neoReady: 'Установлено'/);
  assert.match(source, /neoReady: 'Installed'/);
  assert.match(source, /status\?\.neoforgeReady \? t\.neoReady : t\.neoWaiting/);
  assert.doesNotMatch(source, /neoReady: '[^']*(?:тест|testing)/);
});
