import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGameDirectoryLock, installRelease, verifyInstalledRelease } from '../dist/main/installer.js';
import { assertModSwitchProvenance, readModSwitches, setModEnabled } from '../dist/main/mod-switches.js';
import { moveOptionalMod, SWITCHABLE_MODS } from '../dist/main/optional-mod-files.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const manifestUrl = 'https://github.com/example/kayvel/releases/download/test/manifest.json';

async function fixture(run) {
  const dir = await mkdtemp(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-switch-test-'));
  const root = join(dir, 'game');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const files = SWITCHABLE_MODS.map((mod, index) => ({
    path: mod.path,
    content: Buffer.from(`fictional mod ${index}`),
    url: `https://github.com/example/kayvel/releases/download/test/mod${index}.jar`
  }));
  files.push({ path: 'resourcepacks/example.zip', content: Buffer.from('fictional resource pack'), url: 'https://github.com/example/kayvel/releases/download/test/pack.zip' });
  const manifest = { schemaVersion: 1, buildVersion: 'test', minecraftVersion: '1.21.1', neoforgeVersion: '21.1.252', files: files.map(file => ({ path: file.path, size: file.content.length, sha256: hash(file.content), url: file.url })) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, keys.privateKey).toString('base64');
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === manifestUrl) return new Response(bytes);
    if (url === manifestUrl + '.sig') return new Response(signature);
    const file = files.find(item => item.url === url);
    if (file) return new Response(file.content);
    throw new Error('Unexpected network request: ' + url);
  };
  try {
    await mkdir(join(root, 'saves', 'world'), { recursive: true });
    await mkdir(join(root, 'mods'));
    await writeFile(join(root, 'saves', 'world', 'level.dat'), 'fake world');
    await writeFile(join(root, 'mods', 'personal.jar'), 'personal');
    await writeFile(join(dir, 'outside.txt'), 'outside');
    const enabled = mod => join(root, mod.path);
    const disabled = mod => join(root, '.kayvel', 'disabled-mods', mod.path.split('/')[1]);
    await run({ dir, root, publicKey, privateKey: keys.privateKey, files, manifest, bytes, signature, requests, enabled, disabled });
    assert.equal(await readFile(join(root, 'saves', 'world', 'level.dat'), 'utf8'), 'fake world');
    assert.equal(await readFile(join(root, 'mods', 'personal.jar'), 'utf8'), 'personal');
    assert.equal(await readFile(join(dir, 'outside.txt'), 'utf8'), 'outside');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

async function install(f) { assert.equal(await installRelease(f.root, manifestUrl, f.publicKey), 'test'); }

test('three signed optional mods switch both ways without losing files or breaking release verification', async () => {
  await fixture(async f => {
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    await install(f);
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'enabled'));
    for (const mod of SWITCHABLE_MODS) {
      await setModEnabled(f.root, f.publicKey, mod.id, false);
      assert.deepEqual(await readFile(f.disabled(mod)), f.files.find(file => file.path === mod.path).content);
      await assert.rejects(lstat(f.enabled(mod)), { code: 'ENOENT' });
    }
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'disabled'));
    await verifyInstalledRelease(f.root, f.publicKey);
    const before = f.requests.length;
    await install(f);
    assert.deepEqual(f.requests.slice(before), [manifestUrl, manifestUrl + '.sig']);
    for (const mod of SWITCHABLE_MODS) {
      await setModEnabled(f.root, f.publicKey, mod.id, true);
      assert.deepEqual(await readFile(f.enabled(mod)), f.files.find(file => file.path === mod.path).content);
      await assert.rejects(lstat(f.disabled(mod)), { code: 'ENOENT' });
    }
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'enabled'));
    await verifyInstalledRelease(f.root, f.publicKey);
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'personal', false), /нельзя/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'iris', 'false'), /Некорректный/);
  });
});

test('lock, incomplete installation and legacy provenance prevent switching', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    const release = await acquireGameDirectoryLock(f.root);
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, false), /заблокирована/);
    await release();
    await writeFile(join(f.root, '.kayvel', 'install-incomplete.json'), 'fixture');
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, false), /незавершённая установка/);
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    await unlink(join(f.root, '.kayvel', 'install-incomplete.json'));
    await unlink(join(f.root, '.kayvel', 'optional-mods-managed.json'));
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, false), /происхождение/);
    assert.deepEqual(await readFile(f.enabled(mod)), f.files[0].content);
  });
});

for (const markerType of ['file', 'directory', 'dangling-link']) {
  test(`unfinished preparation blocks switching without changing mods: ${markerType}`, async () => {
    await fixture(async f => {
      await install(f);
      await mkdir(join(f.root, '.preparation'));
      const marker = join(f.root, '.preparation', 'incomplete.json');
      if (markerType === 'file') await writeFile(marker, 'fixture');
      if (markerType === 'directory') await mkdir(marker);
      if (markerType === 'dangling-link') await symlink(join(f.dir, 'absent-directory'), marker, process.platform === 'win32' ? 'junction' : 'dir');
      const before = f.requests.length;
      assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
      await assert.rejects(setModEnabled(f.root, f.publicKey, SWITCHABLE_MODS[0].id, false), /Подготовка не завершена/);
      await assert.rejects(assertModSwitchProvenance(f.root, f.publicKey, f.bytes), /состояние установки изменилось/);
      assert.equal(f.requests.length, before);
      assert.deepEqual(await readFile(f.enabled(SWITCHABLE_MODS[0])), f.files[0].content);
      await assert.rejects(lstat(f.disabled(SWITCHABLE_MODS[0])), { code: 'ENOENT' });
      assert.ok(await lstat(marker));
    });
  });
}

test('modified file and ambiguous duplicate block switching and verification without repair', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    await setModEnabled(f.root, f.publicKey, mod.id, false);
    await writeFile(f.disabled(mod), 'external change');
    assert.equal((await readModSwitches(f.root, f.publicKey))[0].state, 'conflict');
    await assert.rejects(verifyInstalledRelease(f.root, f.publicKey));
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, true));
    assert.equal(await readFile(f.disabled(mod), 'utf8'), 'external change');
    await assert.rejects(lstat(f.enabled(mod)), { code: 'ENOENT' });
  });
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    await mkdir(join(f.root, '.kayvel', 'disabled-mods'));
    await link(f.enabled(mod), f.disabled(mod));
    assert.equal((await readModSwitches(f.root, f.publicKey))[0].state, 'conflict');
    await assert.rejects(verifyInstalledRelease(f.root, f.publicKey), /обе копии/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, false), /обе копии/);
    assert.equal((await lstat(f.enabled(mod))).nlink, 2);
    assert.deepEqual(await readFile(f.enabled(mod)), await readFile(f.disabled(mod)));
  });
});

test('first install refuses an occupied disabled destination before touching mods', async () => {
  await fixture(async f => {
    const mod = SWITCHABLE_MODS[0];
    await mkdir(join(f.root, '.kayvel', 'disabled-mods'), { recursive: true });
    await writeFile(f.disabled(mod), 'unmanaged');
    await assert.rejects(install(f), /уже занят/);
    assert.equal(await readFile(f.disabled(mod), 'utf8'), 'unmanaged');
    assert.deepEqual(await readdir(join(f.root, 'mods')), ['personal.jar']);
    await assert.rejects(lstat(join(f.root, '.kayvel', 'install-incomplete.json')), { code: 'ENOENT' });
  });
});

test('an invalid signature or changed ownership marker cannot authorize switching', async () => {
  await fixture(async f => {
    await install(f);
    const marker = join(f.root, '.kayvel', 'optional-mods-managed.json');
    await writeFile(marker, 'external marker');
    await assert.rejects(readModSwitches(f.root, f.publicKey), /Метка/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'iris', false), /Метка/);
    assert.equal(await readFile(marker, 'utf8'), 'external marker');
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    await assert.rejects(readModSwitches(f.root, other), /signature is invalid/);
    assert.deepEqual(await readFile(f.enabled(SWITCHABLE_MODS[0])), f.files[0].content);
  });
});

test('missing signed manifest with a marker blocks launch verification and switching', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    await setModEnabled(f.root, f.publicKey, mod.id, false);
    const record = join(f.root, '.kayvel', 'signed-manifest.json');
    await unlink(record);
    await assert.rejects(verifyInstalledRelease(f.root, f.publicKey), /манифест отсутствует/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, true), /происхождение/);
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    assert.deepEqual(await readFile(f.disabled(mod)), f.files[0].content);
    await assert.rejects(lstat(f.enabled(mod)), { code: 'ENOENT' });
  });
  await fixture(async f => {
    await mkdir(join(f.root, '.kayvel'));
    await verifyInstalledRelease(f.root, f.publicKey);
  });
});

test('missing marker with a disabled mod blocks verification and switching without restoring files', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    await setModEnabled(f.root, f.publicKey, mod.id, false);
    const marker = join(f.root, '.kayvel', 'optional-mods-managed.json');
    await unlink(marker);
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    await assert.rejects(verifyInstalledRelease(f.root, f.publicKey), /изменён или отсутствует/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, true), /происхождение/);
    await assert.rejects(install(f), /изменён или отсутствует/);
    assert.deepEqual(await readFile(f.disabled(mod)), f.files[0].content);
    await assert.rejects(lstat(f.enabled(mod)), { code: 'ENOENT' });
    await assert.rejects(lstat(marker), { code: 'ENOENT' });
  });
});

test('rechecking provenance before linking and unlinking stops when metadata disappears mid-switch', async () => {
  for (const removed of ['optional-mods-managed.json', 'signed-manifest.json']) {
    for (const removeOnCheck of [1, 2]) {
      await fixture(async f => {
        await install(f);
        const mod = SWITCHABLE_MODS[0];
        const file = f.manifest.files[0];
        const metadata = join(f.root, '.kayvel', removed);
        let checks = 0;
        await assert.rejects(moveOptionalMod(f.root, file, 'disabled', async () => {
          checks++;
          if (checks === removeOnCheck) await unlink(metadata);
          await assertModSwitchProvenance(f.root, f.publicKey, f.bytes);
        }), removeOnCheck === 1 ? /происхождение/ : /Обе копии сохранены/);
        assert.equal(checks, removeOnCheck);
        assert.deepEqual(await readFile(f.enabled(mod)), f.files[0].content);
        if (removeOnCheck === 1) {
          await assert.rejects(lstat(f.disabled(mod)), { code: 'ENOENT' });
          assert.equal((await lstat(f.enabled(mod))).nlink, 1);
        } else {
          assert.deepEqual(await readFile(f.disabled(mod)), f.files[0].content);
          assert.equal((await lstat(f.enabled(mod))).nlink, 2);
          assert.equal((await lstat(f.disabled(mod))).nlink, 2);
        }
        await assert.rejects(lstat(metadata), { code: 'ENOENT' });
      });
    }
  }
});

test('a different valid signed manifest and matching marker cannot replace the checked provenance', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    const bytes = Buffer.from(JSON.stringify({ ...f.manifest, buildVersion: 'different-test' }));
    const signature = sign(null, bytes, f.privateKey).toString('base64');
    let checks = 0;
    await assert.rejects(moveOptionalMod(f.root, f.manifest.files[0], 'disabled', async () => {
      if (++checks === 1) {
        await writeFile(join(f.root, '.kayvel', 'signed-manifest.json'), JSON.stringify({ bytes: bytes.toString('base64'), signature }));
        await writeFile(join(f.root, '.kayvel', 'optional-mods-managed.json'), JSON.stringify({ version: 1, manifestSha256: hash(bytes) }));
      }
      await assertModSwitchProvenance(f.root, f.publicKey, f.bytes);
    }), /происхождение/);
    assert.equal(checks, 1);
    assert.deepEqual(await readFile(f.enabled(mod)), f.files[0].content);
    await assert.rejects(lstat(f.disabled(mod)), { code: 'ENOENT' });
  });
});

test('an incomplete-install marker appearing mid-switch preserves the mod files', async () => {
  for (const markOnCheck of [1, 2]) {
    await fixture(async f => {
      await install(f);
      const mod = SWITCHABLE_MODS[0];
      const marker = join(f.root, '.kayvel', 'install-incomplete.json');
      let checks = 0;
      await assert.rejects(moveOptionalMod(f.root, f.manifest.files[0], 'disabled', async () => {
        if (++checks === markOnCheck) await writeFile(marker, 'partial installation');
        await assertModSwitchProvenance(f.root, f.publicKey, f.bytes);
      }), markOnCheck === 1 ? /состояние установки изменилось/ : /Обе копии сохранены/);
      assert.equal(checks, markOnCheck);
      assert.equal(await readFile(marker, 'utf8'), 'partial installation');
      assert.deepEqual(await readFile(f.enabled(mod)), f.files[0].content);
      if (markOnCheck === 1) await assert.rejects(lstat(f.disabled(mod)), { code: 'ENOENT' });
      else assert.deepEqual(await readFile(f.disabled(mod)), f.files[0].content);
    });
  }
});

test('loss of both metadata files blocks switches but cannot identify an unmanaged game folder', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    await setModEnabled(f.root, f.publicKey, mod.id, false);
    await unlink(join(f.root, '.kayvel', 'optional-mods-managed.json'));
    await unlink(join(f.root, '.kayvel', 'signed-manifest.json'));
    assert.ok((await readModSwitches(f.root, f.publicKey)).every(item => item.state === 'unavailable'));
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, true), /происхождение/);
    await verifyInstalledRelease(f.root, f.publicKey);
    assert.deepEqual(await readFile(f.disabled(mod)), f.files[0].content);
    await assert.rejects(lstat(f.enabled(mod)), { code: 'ENOENT' });
  });
});

test('other damaged signed files and a damaged manifest record prevent a switch', async () => {
  await fixture(async f => {
    await install(f);
    const pack = join(f.root, 'resourcepacks', 'example.zip');
    await writeFile(pack, 'changed by another program');
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'iris', false), /изменён или отсутствует/);
    assert.equal(await readFile(pack, 'utf8'), 'changed by another program');
    assert.deepEqual(await readFile(f.enabled(SWITCHABLE_MODS[0])), f.files[0].content);
  });
  await fixture(async f => {
    await install(f);
    const recordPath = join(f.root, '.kayvel', 'signed-manifest.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.signature = Buffer.alloc(64).toString('base64');
    await writeFile(recordPath, JSON.stringify(record));
    await assert.rejects(verifyInstalledRelease(f.root, f.publicKey), /signature is invalid/);
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'iris', false), /signature is invalid/);
    assert.deepEqual(await readFile(f.enabled(SWITCHABLE_MODS[0])), f.files[0].content);
  });
});

test('a hard-linked external file or linked disabled directory blocks switching without deletion', async () => {
  await fixture(async f => {
    await install(f);
    const mod = SWITCHABLE_MODS[0];
    const alias = join(f.dir, 'other-hardlink.jar');
    await link(f.enabled(mod), alias);
    assert.equal((await readModSwitches(f.root, f.publicKey))[0].state, 'conflict');
    await assert.rejects(setModEnabled(f.root, f.publicKey, mod.id, false));
    assert.deepEqual(await readFile(alias), f.files[0].content);
    assert.equal((await lstat(alias)).nlink, 2);
    await assert.rejects(lstat(f.disabled(mod)), { code: 'ENOENT' });
  });
  await fixture(async f => {
    await install(f);
    const outside = join(f.dir, 'outside-directory');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel.txt'), 'keep');
    await symlink(outside, join(f.root, '.kayvel', 'disabled-mods'), 'junction');
    assert.equal((await readModSwitches(f.root, f.publicKey))[0].state, 'conflict');
    await assert.rejects(setModEnabled(f.root, f.publicKey, 'iris', false), /Небезопасный каталог/);
    assert.deepEqual(await readdir(outside), ['sentinel.txt']);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.deepEqual(await readFile(f.enabled(SWITCHABLE_MODS[0])), f.files[0].content);
  });
});
