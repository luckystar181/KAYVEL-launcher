import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launcherMainFiles } from '../scripts/launcher-main-files.mjs';
import { fileURLToPath } from 'node:url';

test('news is absent from the renderer, IPC and portable runtime', async () => {
  for (const path of ['src/renderer/app.tsx', 'src/renderer/style.css', 'src/main/main.ts', 'src/main/preload.cjs']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /news|Новости|новости/i);
  }
  const files = await launcherMainFiles(fileURLToPath(new URL('../dist/main', import.meta.url)));
  assert.equal(files.includes('news.js'), false);
});

test('memory recommendation is 3–4 GB in both languages without changing allocation', async () => {
  const source = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
  assert.match(source, /Рекомендуется 3–4 ГБ/);
  assert.match(source, /3–4 GB is recommended/);
  assert.doesNotMatch(source, /6–8/);
});
