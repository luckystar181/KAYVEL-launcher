import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalProfileStore } from '../dist/main/local-profile.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const revisionName = i => `${String(i).padStart(6, '0')}.json`;
function fixture(run) {
  const dir = mkdtempSync(join(process.env.KAYVEL_TEST_TMPDIR || tmpdir(), 'kayvel-profile-test-'));
  const root = join(dir, 'local-player');
  const store = () => createLocalProfileStore(dir);
  try { return run({ dir, root, store }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function append(root, index, previous, profile) {
  const bytes = Buffer.from(JSON.stringify({ version: 1, previous, profile }));
  writeFileSync(join(root, 'profile-revisions', revisionName(index)), bytes);
  return bytes;
}

test('nickname-only profiles survive restart and append immutable version 3 revisions', () => {
  fixture(({ root, store }) => {
    const profile = store();
    assert.deepEqual(Object.keys(profile).sort(), ['read', 'saveNickname']);
    assert.deepEqual(profile.read(), { nickname: '' });
    assert.equal(existsSync(root), false);
    assert.deepEqual(profile.saveNickname('Player_1'), { nickname: 'Player_1' });
    const firstPath = join(root, 'profile-revisions', revisionName(1));
    const first = readFileSync(firstPath);
    assert.deepEqual(JSON.parse(first), { version: 1, previous: null, profile: { version: 3, nickname: 'Player_1' } });
    assert.deepEqual(store().saveNickname('Player_2'), { nickname: 'Player_2' });
    assert.deepEqual(store().read(), { nickname: 'Player_2' });
    assert.deepEqual(readFileSync(firstPath), first);
    assert.equal(JSON.parse(readFileSync(join(root, 'profile-revisions', revisionName(2)))).previous, hash(first));
    assert.deepEqual(readdirSync(root).sort(), ['profile-revisions']);
  });
});

test('invalid names never create or alter the profile', () => {
  fixture(({ root, store }) => {
    const profile = store();
    const invalid = ['ab', '../outside', 'CON', 'nul', 'Lpt1', 'Player-name', 'пользователь', '', null, {}, 123, 'a'.repeat(17)];
    for (const name of invalid) assert.throws(() => profile.saveNickname(name));
    assert.equal(existsSync(root), false);
    profile.saveNickname('Player');
    const before = readFileSync(join(root, 'profile-revisions', revisionName(1)));
    for (const name of invalid) assert.throws(() => profile.saveNickname(name));
    assert.deepEqual(readFileSync(join(root, 'profile-revisions', revisionName(1))), before);
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), [revisionName(1)]);
  });
});

for (const skin of [null, 'not a texture', { model: 'invalid', png: '!!!', copyId: '../../outside', sha256: false }, [1, 2, 3]]) {
  test(`legacy texture fields are ignored and never copied: ${JSON.stringify(skin)}`, () => {
    fixture(({ root, store }) => {
      mkdirSync(root);
      mkdirSync(join(root, 'profile-revisions'));
      mkdirSync(join(root, 'skin-copies'));
      writeFileSync(join(root, 'skin-copies', 'keep.png'), 'personal bytes');
      const base = Buffer.from(JSON.stringify({ version: 2, nickname: 'OldName', skin }));
      const path = join(root, 'profile.json');
      writeFileSync(path, base);
      const legacy = append(root, 1, hash(base), { version: 2, nickname: 'LastName', skin });
      assert.deepEqual(store().read(), { nickname: 'LastName' });
      assert.deepEqual(store().saveNickname('NewName'), { nickname: 'NewName' });
      assert.deepEqual(readFileSync(path), base);
      assert.deepEqual(readFileSync(join(root, 'profile-revisions', revisionName(1))), legacy);
      const record = JSON.parse(readFileSync(join(root, 'profile-revisions', revisionName(2))));
      assert.deepEqual(record, { version: 1, previous: hash(legacy), profile: { version: 3, nickname: 'NewName' } });
      assert.equal(readFileSync(join(root, 'skin-copies', 'keep.png'), 'utf8'), 'personal bytes');
      assert.deepEqual(readdirSync(join(root, 'skin-copies')), ['keep.png']);
      assert.deepEqual(store().read(), { nickname: 'NewName' });
      writeFileSync(path, JSON.stringify({ version: 2, nickname: 'External', skin }));
      assert.throws(() => store().read(), /повреждён/);
      assert.throws(() => store().saveNickname('Third'), /повреждён/);
      assert.equal(readdirSync(join(root, 'profile-revisions')).length, 2);
    });
  });
}

test('legacy profile and revision size limits remain backward compatible', () => {
  fixture(({ root, store }) => {
    mkdirSync(root);
    mkdirSync(join(root, 'profile-revisions'));
    const profile = { version: 2, nickname: 'Player', skin: 'x'.repeat(1_499_940) };
    const base = Buffer.from(JSON.stringify(profile));
    assert.ok(base.length <= 1_500_000);
    writeFileSync(join(root, 'profile.json'), base);
    const revision = append(root, 1, hash(base), profile);
    assert.ok(revision.length > 1_500_000 && revision.length <= 1_501_024);
    assert.deepEqual(store().read(), { nickname: 'Player' });
    store().saveNickname('NextPlayer');
    assert.deepEqual(readFileSync(join(root, 'profile.json')), base);
    assert.deepEqual(readFileSync(join(root, 'profile-revisions', revisionName(1))), revision);
  });
});

for (const target of ['base', 'revision']) {
  test(`post-read size limit refuses ${target} growth after stat without changing originals`, t => {
    fixture(({ root, store }) => {
      mkdirSync(root);
      const revisions = join(root, 'profile-revisions');
      const base = Buffer.from(JSON.stringify({ version: 2, nickname: 'Player', skin: null }));
      const basePath = join(root, 'profile.json');
      writeFileSync(basePath, base);
      mkdirSync(revisions);
      const revision = target === 'revision' ? append(root, 1, hash(base), { version: 3, nickname: 'Player' }) : null;
      const revisionPath = join(revisions, revisionName(1));
      const path = target === 'base' ? basePath : revisionPath;
      const original = target === 'base' ? base : revision;
      const limit = target === 'base' ? 1_500_000 : 1_501_024;
      assert.ok(lstatSync(path).size < limit);
      const nativeRead = fs.readFileSync;
      let returnedSize = limit;
      let reads = 0;
      t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file !== path) return nativeRead(file, ...args);
        reads++;
        const bytes = Buffer.alloc(returnedSize, 32);
        original.copy(bytes);
        return bytes;
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(store().read(), { nickname: 'Player' });
        returnedSize = limit + 1;
        assert.throws(() => store().read(), /повреждён/);
        assert.throws(() => store().saveNickname('Other'), /повреждён/);
        assert.equal(reads, 3);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.deepEqual(readFileSync(basePath), base);
      if (revision) assert.deepEqual(readFileSync(revisionPath), revision);
      assert.deepEqual(readdirSync(revisions), revision ? [revisionName(1)] : []);
      assert.deepEqual(readdirSync(root).sort(), ['profile-revisions', 'profile.json']);
      assert.deepEqual(store().read(), { nickname: 'Player' });
    });
  });
}

for (const damage of ['partial', 'modified', 'gap', 'unexpected']) {
  test(`damaged revision history blocks reads and saves without deletion: ${damage}`, () => {
    fixture(({ root, store }) => {
      const profile = store();
      for (const name of ['First', 'Second', 'Third']) profile.saveNickname(name);
      const revisions = join(root, 'profile-revisions');
      const first = readFileSync(join(revisions, revisionName(1)));
      const third = readFileSync(join(revisions, revisionName(3)));
      const second = join(revisions, revisionName(2));
      if (damage === 'partial') writeFileSync(second, '{"version":');
      if (damage === 'modified') {
        const record = JSON.parse(readFileSync(second));
        record.profile.nickname = 'External';
        writeFileSync(second, JSON.stringify(record));
      }
      if (damage === 'gap') unlinkSync(second);
      if (damage === 'unexpected') writeFileSync(join(revisions, 'unexpected.txt'), 'keep');
      assert.throws(() => store().read(), /повреждён/);
      assert.throws(() => store().saveNickname('Fourth'), /повреждён/);
      assert.deepEqual(readFileSync(join(revisions, revisionName(1))), first);
      assert.deepEqual(readFileSync(join(revisions, revisionName(3))), third);
      assert.equal(existsSync(join(revisions, revisionName(4))), false);
      if (damage === 'unexpected') assert.equal(readFileSync(join(revisions, 'unexpected.txt'), 'utf8'), 'keep');
    });
  });
}

test('an incomplete last revision is preserved and blocks writes', () => {
  fixture(({ root, store }) => {
    store().saveNickname('First');
    const path = join(root, 'profile-revisions', revisionName(2));
    writeFileSync(path, '{"version":1,"previous":');
    assert.throws(() => store().read(), /повреждён/);
    assert.throws(() => store().saveNickname('Other'), /повреждён/);
    assert.equal(readFileSync(path, 'utf8'), '{"version":1,"previous":');
    assert.deepEqual(readdirSync(join(root, 'profile-revisions')), [revisionName(1), revisionName(2)]);
  });
});

test('the last revision cannot authenticate itself against external edits or removal', () => {
  fixture(({ root, store }) => {
    store().saveNickname('First');
    store().saveNickname('Second');
    const last = join(root, 'profile-revisions', revisionName(2));
    const record = JSON.parse(readFileSync(last));
    record.profile.nickname = 'External';
    writeFileSync(last, JSON.stringify(record));
    assert.equal(store().read().nickname, 'External');
    unlinkSync(last);
    assert.equal(store().read().nickname, 'First');
  });
});

test('a pre-existing lock prevents writes and is never removed by a failed save', () => {
  fixture(({ root, store }) => {
    store().saveNickname('Player');
    const lock = join(root, 'profile.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.txt'), 'other process');
    assert.throws(() => store().saveNickname('Other'), /заблокирован/);
    assert.equal(readFileSync(join(lock, 'owner.txt'), 'utf8'), 'other process');
    assert.deepEqual(store().read(), { nickname: 'Player' });
    assert.equal(readdirSync(join(root, 'profile-revisions')).length, 1);
  });
});

for (const target of ['root', 'revisions', 'base', 'revision']) {
  test(`linked active profile paths are refused: ${target}`, () => {
    fixture(({ dir, root, store }) => {
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      const bytes = Buffer.from(JSON.stringify({ version: 3, nickname: 'Player' }));
      writeFileSync(join(outside, 'keep.json'), bytes);
      if (target === 'root') symlinkSync(outside, root, 'junction');
      else {
        mkdirSync(root);
        if (target === 'revisions') symlinkSync(outside, join(root, 'profile-revisions'), 'junction');
        if (target === 'base') symlinkSync(join(outside, 'keep.json'), join(root, 'profile.json'), 'file');
        if (target === 'revision') {
          mkdirSync(join(root, 'profile-revisions'));
          symlinkSync(join(outside, 'keep.json'), join(root, 'profile-revisions', revisionName(1)), 'file');
        }
      }
      assert.throws(() => store().read(), /ссылкой|повреждён/);
      assert.throws(() => store().saveNickname('Other'), /ссылкой|повреждён/);
      assert.deepEqual(readFileSync(join(outside, 'keep.json')), bytes);
      assert.deepEqual(readdirSync(outside), ['keep.json']);
    });
  });
}

test('obsolete texture directories are not inspected even when linked', () => {
  fixture(({ dir, root, store }) => {
    store().saveNickname('Player');
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.png'), 'keep');
    symlinkSync(outside, join(root, 'skin-copies'), 'junction');
    assert.deepEqual(store().saveNickname('Other'), { nickname: 'Other' });
    assert.deepEqual(readdirSync(outside), ['keep.png']);
    assert.equal(readFileSync(join(outside, 'keep.png'), 'utf8'), 'keep');
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

for (const value of [null, [], { version: 1, nickname: 'Player' }, { version: 3, nickname: '../bad' }, { version: 3, nickname: 'CON' }, { version: 3, nickname: 42 }, 'x'.repeat(1_500_001)]) {
  test(`invalid base profile blocks writing: ${typeof value === 'object' ? JSON.stringify(value) : 'oversized'}`, () => {
    fixture(({ root, store }) => {
      mkdirSync(root);
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const path = join(root, 'profile.json');
      writeFileSync(path, bytes);
      assert.throws(() => store().read(), /повреждён/);
      assert.throws(() => store().saveNickname('Other'), /повреждён/);
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(existsSync(join(root, 'profile-revisions')), false);
    });
  });
}

test('revision count and record size limits preserve all existing data', () => {
  fixture(({ root, store }) => {
    mkdirSync(root);
    const revisions = join(root, 'profile-revisions');
    mkdirSync(revisions);
    let previous = null;
    for (let i = 1; i <= 256; i++) previous = hash(append(root, i, previous, { version: 2, nickname: 'Player', skin: null }));
    assert.equal(store().read().nickname, 'Player');
    assert.throws(() => store().saveNickname('Other'), /предел/);
    assert.equal(readdirSync(revisions).length, 256);
    const oversized = Buffer.alloc(1_501_025, 32);
    writeFileSync(join(revisions, revisionName(256)), oversized);
    assert.throws(() => store().read(), /повреждён/);
    assert.throws(() => store().saveNickname('Other'), /повреждён/);
    assert.deepEqual(readFileSync(join(revisions, revisionName(256))), oversized);
    append(root, 257, previous, { version: 3, nickname: 'Player' });
    assert.throws(() => store().read(), /повреждён/);
    assert.equal(readdirSync(revisions).length, 257);
  });
});
