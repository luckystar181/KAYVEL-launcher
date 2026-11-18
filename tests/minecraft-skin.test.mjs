import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launcherMainFiles } from '../scripts/launcher-main-files.mjs';

test('skins use PNG files only, with no nickname lookup UI, IPC or packaged backend', async () => {
  for (const name of ['src/main/main.ts', 'src/main/preload.cjs', 'src/renderer/app.tsx', 'src/renderer/style.css']) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /skinByNickname|skin-by-nickname|skin-lookup|lookupMinecraftSkin|chooseNameMc/);
  }
  const ui = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
  assert.match(ui, /type="file" accept="image\/png"/);
  assert.match(ui, /window\.kayvel\.saveLocalSkin/);
  const files = await launcherMainFiles(fileURLToPath(new URL('../dist/main', import.meta.url)));
  assert.equal(files.includes('minecraft-skin.js'), false);
});
