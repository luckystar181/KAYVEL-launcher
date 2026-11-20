import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launcherMainFiles } from '../scripts/launcher-main-files.mjs';

test('local skin selection, IPC, application and previews are absent from the launcher', async () => {
  for (const name of ['src/main/main.ts', 'src/main/preload.cjs', 'src/renderer/app.tsx', 'src/renderer/skin-guide.tsx', 'src/renderer/style.css']) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /saveLocalSkin|applyLocalSkin|local-skin-save|skin-preview|skin-upload|skinview3d|nativeImage|createImageBitmap|type="file"|<canvas/i, name);
  }
  const profile = await readFile(new URL('../src/main/local-profile.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(profile, /saveSkin|StoredSkin|SkinModel|copyPath|copyReady|base64|skin-copies|\.png|applyLocalSkin/);
  for (const name of ['src/main/game-skin.ts', 'src/renderer/skin-head.tsx', 'src/renderer/skin-preview-3d.tsx', 'src/renderer/skin-preview-helpers.ts', 'modpack/kubejs/config/kayvel-customskinloader.json']) {
    await assert.rejects(access(new URL(`../${name}`, import.meta.url)), { code: 'ENOENT' });
  }
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(lock.packages)) assert.doesNotMatch(name, /skinview3d|skinview-utils|node_modules\/three(?:$|\/)|@types\/three/);
  const files = await launcherMainFiles(fileURLToPath(new URL('../dist/main', import.meta.url)));
  assert.equal(files.some(name => /skin/i.test(name)), false);
});
