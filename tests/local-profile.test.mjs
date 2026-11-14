import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createLocalProfileStore } from '../dist/main/local-profile.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

function png(height = 64, pixel = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((64 * 4 + 1) * height);
  for (let row = 0; row < height; row++) rows[row * (64 * 4 + 1) + 1] = pixel;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(run) {
  const dir = mkdtempSync(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-profile-test-'));
  const root = join(dir, 'local-player');
  const store = (decoder = () => true) => createLocalProfileStore(dir, decoder);
  try { return run({ dir, root, store }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function baseProfile(nickname, bytes) {
  return { version: 2, nickname, skin: { model: 'classic', sha256: hash(bytes), png: bytes.toString('base64'), copyId: '12345678-1234-4123-8123-123456789abc' } };
}

test('local nickname and separate PNG copies survive restart, skin change and nickname change', () => {
  fixture(({ dir, root, store }) => {
    const source = join(dir, 'source-not-renamed.png');
    const first = png();
    const second = png(32, 57);
    writeFileSync(source, first);
    const profile = store();
    assert.deepEqual(profile.read(), { nickname: '', skin: null });
    assert.throws(() => profile.saveSkin(first, 'classic'), /Сначала сохраните ник/);
    assert.equal(profile.saveNickname('Player_1').nickname, 'Player_1');
    const saved = profile.saveSkin(readFileSync(source), 'classic');
    assert.equal(saved.skin.copyReady, true);
    assert.equal(basename(saved.skin.copyPath), 'Player_1.png');
    assert.deepEqual(readFileSync(saved.skin.copyPath), first);
    assert.deepEqual(readFileSync(source), first);
    assert.equal(lstatSync(saved.skin.copyPath).nlink, 1);
    assert.deepEqual(store().read(), saved);
    const changedSkin = profile.saveSkin(second, 'slim');
    assert.notEqual(changedSkin.skin.copyPath, saved.skin.copyPath);
    assert.deepEqual(readFileSync(saved.skin.copyPath), first);
    assert.deepEqual(readFileSync(changedSkin.skin.copyPath), second);
    assert.equal(changedSkin.skin.model, 'slim');
    const renamed = profile.saveNickname('Player_2');
    assert.equal(basename(renamed.skin.copyPath), 'Player_2.png');
    assert.notEqual(renamed.skin.copyPath, changedSkin.skin.copyPath);
    assert.deepEqual(readFileSync(renamed.skin.copyPath), second);
    assert.deepEqual(readFileSync(changedSkin.skin.copyPath), second);
    assert.deepEqual(readFileSync(source), first);
    assert.deepEqual(store().read(), renamed);
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), ['000001.json', '000002.json', '000003.json', '000004.json']);
  });
});

test('invalid names, malformed PNGs, oversized input and decoder rejection do not alter the profile', () => {
  fixture(({ root, store }) => {
    const profile = store();
    for (const name of ['ab', '../outside', 'CON', 'nul', 'Lpt1', 'Player-name', 'пользователь', '', null]) {
      assert.throws(() => profile.saveNickname(name));
    }
    assert.equal(existsSync(root), false);
    profile.saveNickname('Player');
    const before = readFileSync(join(root, 'profile-revisions', '000001.json'));
    const wrongWidth = png();
    wrongWidth.writeUInt32BE(32, 16);
    const wrongHeight = png();
    wrongHeight.writeUInt32BE(48, 20);
    const wrongHeader = Buffer.from(png());
    wrongHeader[0] = 0;
    const truncated = png().subarray(0, 20);
    for (const bad of [null, 'not bytes', wrongWidth, wrongHeight, wrongHeader, truncated, Buffer.alloc(1_048_577)]) {
      assert.throws(() => profile.saveSkin(bad, 'classic'), /корректный PNG/);
    }
    assert.throws(() => profile.saveSkin(png(), 'other'), /корректный PNG/);
    assert.throws(() => store(() => false).saveSkin(png(), 'classic'), /корректный PNG/);
    assert.deepEqual(readFileSync(join(root, 'profile-revisions', '000001.json')), before);
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), ['000001.json']);
    assert.deepEqual(profile.read(), { nickname: 'Player', skin: null });
  });
});

test('an existing version 2 profile remains unchanged as the immutable base of new revisions', () => {
  fixture(({ root, store }) => {
    mkdirSync(root);
    const base = Buffer.from(JSON.stringify(baseProfile('OldName', png())));
    const path = join(root, 'profile.json');
    writeFileSync(path, base);
    const profile = store();
    assert.equal(profile.read().nickname, 'OldName');
    assert.equal(profile.read().skin.copyReady, false);
    const result = profile.saveNickname('NewName');
    assert.equal(result.nickname, 'NewName');
    assert.equal(result.skin.copyReady, true);
    assert.deepEqual(readFileSync(path), base);
    const record = JSON.parse(readFileSync(join(root, 'profile-revisions', '000001.json'), 'utf8'));
    assert.equal(record.previous, hash(base));
    assert.deepEqual(store().read(), result);
    writeFileSync(path, JSON.stringify(baseProfile('Other', png())));
    assert.throws(() => store().read(), /повреждён/);
    assert.throws(() => store().saveNickname('Third'), /повреждён/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).nickname, 'Other');
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), ['000001.json']);
  });
});

test('partial, malformed, missing intermediate and externally changed revisions stop reads and writes', () => {
  for (const damage of ['partial', 'modified', 'gap', 'unexpected']) {
    fixture(({ root, store }) => {
      const profile = store();
      profile.saveNickname('First');
      profile.saveNickname('Second');
      profile.saveNickname('Third');
      const revisions = join(root, 'profile-revisions');
      const first = join(revisions, '000001.json');
      const second = join(revisions, '000002.json');
      const third = join(revisions, '000003.json');
      const firstBefore = readFileSync(first);
      const thirdBefore = readFileSync(third);
      if (damage === 'partial') writeFileSync(second, '{"version":');
      if (damage === 'modified') {
        const record = JSON.parse(readFileSync(second, 'utf8'));
        record.profile.nickname = 'External';
        writeFileSync(second, JSON.stringify(record));
      }
      if (damage === 'gap') unlinkSync(second);
      if (damage === 'unexpected') writeFileSync(join(revisions, 'unexpected.txt'), 'do not remove');
      assert.throws(() => store().read(), /повреждён/, damage);
      assert.throws(() => store().saveNickname('Fourth'), /повреждён/, damage);
      assert.deepEqual(readFileSync(first), firstBefore);
      assert.deepEqual(readFileSync(third), thirdBefore);
      assert.equal(existsSync(join(revisions, '000004.json')), false);
      if (damage === 'unexpected') assert.equal(readFileSync(join(revisions, 'unexpected.txt'), 'utf8'), 'do not remove');
    });
  }
});

test('an incomplete last revision blocks reads and saves without modifying earlier data', () => {
  fixture(({ root, store }) => {
    const profile = store();
    profile.saveNickname('First');
    profile.saveSkin(png(), 'classic');
    const revisions = join(root, 'profile-revisions');
    const first = join(revisions, '000001.json');
    const last = join(revisions, '000002.json');
    const firstBefore = readFileSync(first);
    const copyRoot = join(root, 'skin-copies');
    const copyDir = readdirSync(copyRoot)[0];
    const copyPath = join(copyRoot, copyDir, 'First.png');
    const copyBefore = readFileSync(copyPath);
    writeFileSync(last, '{"version":1,"previous":');
    assert.throws(() => profile.read(), /повреждён/);
    assert.throws(() => profile.saveNickname('Other'), /повреждён/);
    assert.deepEqual(readFileSync(first), firstBefore);
    assert.equal(readFileSync(last, 'utf8'), '{"version":1,"previous":');
    assert.deepEqual(readFileSync(copyPath), copyBefore);
    assert.deepEqual(readdirSync(revisions), ['000001.json', '000002.json']);
  });
});

test('the last revision cannot authenticate itself against external edits or removal', () => {
  fixture(({ root, store }) => {
    const profile = store();
    profile.saveNickname('First');
    profile.saveNickname('Second');
    const last = join(root, 'profile-revisions', '000002.json');
    const record = JSON.parse(readFileSync(last, 'utf8'));
    record.profile.nickname = 'External';
    writeFileSync(last, JSON.stringify(record));
    assert.equal(store().read().nickname, 'External');
    unlinkSync(last);
    assert.equal(store().read().nickname, 'First');
  });
});

test('a changed or missing PNG copy is reported without automatic repair or overwriting', () => {
  fixture(({ root, store }) => {
    const profile = store();
    profile.saveNickname('Player');
    const saved = profile.saveSkin(png(), 'classic');
    const path = saved.skin.copyPath;
    writeFileSync(path, 'external data');
    assert.equal(profile.read().skin.copyReady, false);
    assert.equal(readFileSync(path, 'utf8'), 'external data');
    const next = profile.saveSkin(Buffer.from(saved.skin.bytes), 'classic');
    assert.notEqual(next.skin.copyPath, path);
    assert.equal(readFileSync(path, 'utf8'), 'external data');
    unlinkSync(next.skin.copyPath);
    assert.equal(store().read().skin.copyReady, false);
    assert.equal(existsSync(next.skin.copyPath), false);
    assert.equal(readdirSync(join(root, 'profile-revisions')).length, 3);
  });
});

test('a pre-existing lock prevents writes and is never removed by a failed save', () => {
  fixture(({ root, store }) => {
    const profile = store();
    profile.saveNickname('Player');
    const lock = join(root, 'profile.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.txt'), 'other process');
    assert.throws(() => profile.saveNickname('Other'), /заблокирован/);
    assert.equal(readFileSync(join(lock, 'owner.txt'), 'utf8'), 'other process');
    assert.equal(profile.read().nickname, 'Player');
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), ['000001.json']);
  });
});

test('external base change observed before commit aborts without replacing either base or copy', () => {
  fixture(({ dir, root }) => {
    mkdirSync(root);
    const path = join(root, 'profile.json');
    const original = Buffer.from(JSON.stringify(baseProfile('Original', png())));
    const external = Buffer.from(JSON.stringify(baseProfile('External', png())));
    writeFileSync(path, original);
    let mutate = true;
    const profile = createLocalProfileStore(dir, () => {
      if (mutate) { mutate = false; writeFileSync(path, external); }
      return true;
    });
    assert.throws(() => profile.saveNickname('Requested'), /изменён извне/);
    assert.deepEqual(readFileSync(path), external);
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), []);
    const copies = readdirSync(join(root, 'skin-copies'));
    assert.equal(copies.length, 1);
    assert.deepEqual(readFileSync(join(root, 'skin-copies', copies[0], 'Requested.png')), png());
    assert.equal(profile.read().nickname, 'External');
  });
});

test('linked profile directories are refused and external files remain untouched', () => {
  fixture(({ dir, root, store }) => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel.txt'), 'keep');
    symlinkSync(outside, root, 'junction');
    assert.throws(() => store().read(), /ссылкой/);
    assert.throws(() => store().saveNickname('Player'), /ссылкой/);
    assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep');
  });
  fixture(({ dir, root, store }) => {
    const profile = store();
    profile.saveNickname('Player');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel.txt'), 'keep');
    symlinkSync(outside, join(root, 'skin-copies'), 'junction');
    assert.throws(() => profile.saveSkin(png(), 'classic'), /ссылкой/);
    assert.deepEqual(readdirSync(outside), ['sentinel.txt']);
    assert.equal(profile.read().skin, null);
  });
});

test('hard-linked existing profile records are read only, not rewritten', () => {
  fixture(({ dir, root, store }) => {
    mkdirSync(root);
    const outside = join(dir, 'outside-profile.json');
    const base = Buffer.from(JSON.stringify({ version: 2, nickname: 'Player', skin: null }));
    writeFileSync(outside, base);
    linkSync(outside, join(root, 'profile.json'));
    assert.equal(store().read().nickname, 'Player');
    store().saveNickname('Other');
    assert.deepEqual(readFileSync(outside), base);
    assert.equal(lstatSync(outside).nlink, 2);
  });
});

test('the revision limit blocks another change without deleting history', () => {
  fixture(({ root, store }) => {
    mkdirSync(root);
    const revisions = join(root, 'profile-revisions');
    mkdirSync(revisions);
    let previous = null;
    for (let i = 1; i <= 256; i++) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, previous, profile: { version: 2, nickname: 'Player', skin: null } }));
      writeFileSync(join(revisions, `${String(i).padStart(6, '0')}.json`), bytes);
      previous = hash(bytes);
    }
    assert.equal(store().read().nickname, 'Player');
    assert.throws(() => store().saveNickname('Other'), /предел/);
    assert.equal(readdirSync(revisions).length, 256);
    assert.equal(existsSync(join(revisions, '000257.json')), false);
  });
});
