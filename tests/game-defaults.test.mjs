import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { addDefaultServer, defaultServerAddress, migrateDefaultServer, previousDefaultServerAddress } from '../dist/main/default-server.js';
import { applyGameDefaults, defaultKeyBindings } from '../dist/main/game-defaults.js';

const cat = (...parts) => Buffer.concat(parts.map(part => typeof part === 'number' ? Buffer.from([part]) : part));
const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const word = value => { const bytes = Buffer.from(value); const size = Buffer.alloc(2); size.writeUInt16BE(bytes.length); return cat(size, bytes); };
const text = (name, value) => cat(8, word(name), word(value));
const server = (address = 'personal.example:25565', name = 'Мой сервер') => cat(text('name', name), text('ip', address), text('icon', 'keep-icon'), 1, word('acceptTextures'), 1, 0);
const target = cat(text('name', 'KAYVEL'), text('ip', defaultServerAddress), 0);
const root = (entries = [], rest = Buffer.alloc(0)) => cat(10, word(''), 9, word('servers'), 10, int(entries.length), ...entries, rest, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(run) {
  const dir = mkdtempSync(join(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir(), 'kayvel-defaults-test-'));
  const game = join(dir, 'game');
  const metadata = join(game, '.kayvel');
  const history = join(metadata, 'game-defaults-v1');
  mkdirSync(metadata, { recursive: true });
  try { return run({ dir, game, metadata, history }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('new server list is an uncompressed NBT compound with one KAYVEL entry', () => {
  assert.deepEqual(addDefaultServer(null), root([target]));
  assert.deepEqual(addDefaultServer(cat(10, word(''), 0)), root([target]));
});

test('existing servers, icons, flags and unrelated NBT tags retain their original bytes and order', () => {
  const rest = cat(text('custom', 'личные данные'), 7, word('bytes'), int(3), Buffer.from([0, 1, 255]), 11, word('ints'), int(1), int(42), 12, word('longs'), int(1), Buffer.alloc(8));
  const previous = root([server(), server('other.example')], rest);
  assert.deepEqual(addDefaultServer(previous), root([server(), server('other.example'), target], rest));
  const absentList = cat(10, word('root-name'), rest, 0);
  assert.deepEqual(addDefaultServer(absentList), cat(10, word('root-name'), rest, 9, word('servers'), 10, int(1), target, 0));
});

for (const compressed of [false, true]) {
  test(`existing current address is not duplicated, compression=${compressed}`, () => {
    const bytes = root([server(defaultServerAddress, 'Моё имя')]);
    const previous = compressed ? gzipSync(bytes) : bytes;
    assert.deepEqual(addDefaultServer(previous), previous);
  });
  test(`legacy address receives the new default on a fresh application, compression=${compressed}`, () => {
    const bytes = root([server(previousDefaultServerAddress, 'Моё имя')]);
    const previous = compressed ? gzipSync(bytes) : bytes;
    const next = addDefaultServer(previous);
    assert.deepEqual(compressed ? gunzipSync(next) : next, root([server(previousDefaultServerAddress, 'Моё имя'), target]));
  });
  test(`appending preserves format, compression=${compressed}`, () => {
    const previous = root([server()]);
    const next = addDefaultServer(compressed ? gzipSync(previous) : previous);
    assert.deepEqual(compressed ? gunzipSync(next) : next, root([server(), target]));
  });
}

test('legacy migration changes only the old automatically-added KAYVEL entry', () => {
  const previous = root([
    server(previousDefaultServerAddress, 'KAYVEL'),
    server(previousDefaultServerAddress, 'Пользовательский сервер'),
    server('other.example:25565', 'Другой сервер')
  ]);
  assert.deepEqual(migrateDefaultServer(previous), root([
    server(defaultServerAddress, 'KAYVEL'),
    server(previousDefaultServerAddress, 'Пользовательский сервер'),
    server('other.example:25565', 'Другой сервер')
  ]));
  const compressed = gzipSync(previous);
  assert.deepEqual(gunzipSync(migrateDefaultServer(compressed)), root([
    server(defaultServerAddress, 'KAYVEL'),
    server(previousDefaultServerAddress, 'Пользовательский сервер'),
    server('other.example:25565', 'Другой сервер')
  ]));
});

for (const compressed of [false, true]) {
  test(`migration preserves edited and ambiguous entries byte-for-byte, compression=${compressed}`, () => {
    const cases = [
      root([server(` ${previousDefaultServerAddress}`, 'KAYVEL')]),
      root([server(`${previousDefaultServerAddress} `, 'KAYVEL')]),
      root([server(previousDefaultServerAddress.toUpperCase(), 'KAYVEL')]),
      root([server(previousDefaultServerAddress, 'kayvel')]),
      root([server(previousDefaultServerAddress, 'KAYVEL ')]),
      root([server('personal.example:25565', 'KAYVEL')]),
      root([server(previousDefaultServerAddress, 'KAYVEL'), server(previousDefaultServerAddress, 'KAYVEL')]),
      root([cat(text('name', 'KAYVEL'), text('name', 'KAYVEL'), text('ip', previousDefaultServerAddress), 0)]),
      root()
    ];
    for (const bytes of cases) {
      const previous = compressed ? gzipSync(bytes) : bytes;
      assert.strictEqual(migrateDefaultServer(previous), previous);
    }
    assert.equal(migrateDefaultServer(null), null);
  });
}

test('empty TAG_End list can be initialized', () => {
  assert.deepEqual(addDefaultServer(cat(10, word(''), 9, word('servers'), 0, int(0), 0)), root([target]));
});

for (const [name, bytes] of Object.entries({
  truncated: Buffer.from([10]),
  text: Buffer.from('personal non-NBT contents'),
  trailing: cat(root(), 1),
  wrongRoot: Buffer.from([0]),
  wrongList: cat(10, word(''), text('servers', 'personal'), 0),
  wrongElement: cat(10, word(''), 9, word('servers'), 8, int(0), 0),
  duplicateList: cat(10, word(''), 9, word('servers'), 10, int(0), 9, word('servers'), 10, int(0), 0),
  negativeList: cat(10, word(''), 9, word('servers'), 10, int(-1), 0),
  hugeList: cat(10, word(''), 9, word('servers'), 10, int(100_001), 0),
  missingIp: root([cat(text('name', 'keep'), 0)]),
  duplicateIp: root([cat(text('ip', 'a'), text('ip', 'b'), 0)]),
  malformedAfterTarget: root([target, cat(text('name', 'keep'), 0)]),
  gzipBomb: gzipSync(Buffer.alloc(4_194_305)),
  deep: cat(10, word(''), ...Array.from({ length: 34 }, () => cat(10, word('nested'))), Buffer.alloc(35))
})) test(`unsafe server data is rejected: ${name}`, () => assert.throws(() => addDefaultServer(bytes)));

test('key defaults assign X/C, clear conflicts including modifiers, and preserve unrelated settings and CRLF', () => {
  const previous = Buffer.from('version:3955\r\nsoundCategory_master:0.25\r\nkey_key.attack:key.mouse.left\r\nkey_key.sable_player_ragdoll.ragdoll:key.keyboard.r\r\nkey_key.freecam.toggle:key.keyboard.f4\r\nkey_key.custom:key.keyboard.x:SHIFT\r\nkey_key.other:key.keyboard.c\r\nkey_key.easy_villagers.cycle_trades:key.keyboard.j\r\n');
  const next = defaultKeyBindings(previous).toString();
  for (const line of ['version:3955', 'soundCategory_master:0.25', 'key_key.attack:key.mouse.left', 'key_key.easy_villagers.cycle_trades:key.keyboard.j', 'key_key.sable_player_ragdoll.ragdoll:key.keyboard.x', 'key_key.freecam.toggle:key.keyboard.c', 'key_key.custom:key.keyboard.unknown', 'key_key.other:key.keyboard.unknown', 'key_key.let_it_walk.raise:key.keyboard.unknown', 'key_powergrid.keyinfo.switch_layer:key.keyboard.unknown', 'key_tfmg.keyinfo.transmission_shift_down:key.keyboard.unknown', 'key_key.createbigcannons.pitch_mode:key.keyboard.unknown', 'key_key.droneworks.commander_freelook:key.keyboard.unknown']) assert.ok(next.includes(line + '\r\n'), line);
  assert.equal(next.replaceAll('\r\n', '').includes('\n'), false);
  assert.deepEqual(defaultKeyBindings(Buffer.from(next)), Buffer.from(next));
});

test('fresh key defaults, missing terminal newline and duplicate target bindings are handled', () => {
  const next = defaultKeyBindings(null).toString();
  assert.ok(next.includes('key_key.sable_player_ragdoll.ragdoll:key.keyboard.x\n'));
  assert.ok(next.includes('key_key.freecam.toggle:key.keyboard.c\n'));
  assert.ok(defaultKeyBindings(Buffer.from('music:0')).toString().startsWith('music:0\n'));
  const duplicates = defaultKeyBindings(Buffer.from('key_key.freecam.toggle:key.keyboard.r\nkey_key.freecam.toggle:key.keyboard.j\n')).toString();
  assert.equal(duplicates.split('key_key.freecam.toggle:key.keyboard.c').length, 3);
  for (const bytes of [Buffer.from([255]), Buffer.from('a\0b')]) assert.throws(() => defaultKeyBindings(bytes));
});

test('defaults are applied once, originals backed up and subsequent player choices preserved', () => fixture(({ game, history }) => {
  const options = Buffer.from('soundCategory_master:0.5\nkey_key.custom:key.keyboard.x\n');
  const servers = root([server()]);
  writeFileSync(join(game, 'options.txt'), options);
  writeFileSync(join(game, 'servers.dat'), servers);
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(history, `${hash(options)}.options.txt.bak`)), options);
  assert.deepEqual(readFileSync(join(history, `${hash(servers)}.servers.dat.bak`)), servers);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), root([server(), target]));
  writeFileSync(join(game, 'options.txt'), 'player changed bindings');
  writeFileSync(join(game, 'servers.dat'), root());
  applyGameDefaults(game);
  assert.equal(readFileSync(join(game, 'options.txt'), 'utf8'), 'player changed bindings');
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), root());
  assert.equal(readdirSync(game).some(name => name.endsWith('.tmp')), false);
}));

test('legacy completion marker migrates only the old KAYVEL server and preserves user servers', () => fixture(({ game, history }) => {
  const previous = root([
    server(previousDefaultServerAddress, 'KAYVEL'),
    server(previousDefaultServerAddress, 'Пользовательский сервер')
  ]);
  mkdirSync(history, { recursive: true });
  const owner = Buffer.from('KAYVEL game defaults v1\n');
  writeFileSync(join(history, 'owner.txt'), owner);
  writeFileSync(join(history, 'server-play2go.done'), owner);
  writeFileSync(join(game, 'servers.dat'), previous);
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), root([
    server(defaultServerAddress, 'KAYVEL'),
    server(previousDefaultServerAddress, 'Пользовательский сервер')
  ]));
  assert.deepEqual(readFileSync(join(history, `${hash(previous)}.servers.dat.bak`)), previous);
  assert.ok(readFileSync(join(history, 'server-play2go-c9.done')).equals(owner));
  const migrated = readFileSync(join(game, 'servers.dat'));
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), migrated);
}));


test('without legacy marker the old KAYVEL entry is preserved and only the new default is appended', () => fixture(({ game }) => {
  const previous = root([server(previousDefaultServerAddress, 'KAYVEL')]);
  writeFileSync(join(game, 'servers.dat'), previous);
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), root([server(previousDefaultServerAddress, 'KAYVEL'), target]));
}));

for (const entries of [
  [server(previousDefaultServerAddress.toUpperCase(), 'KAYVEL')],
  [server(previousDefaultServerAddress, 'Мой сервер')],
  [server(previousDefaultServerAddress, 'KAYVEL'), server(previousDefaultServerAddress, 'KAYVEL')],
  []
]) test(`legacy marker never replaces edited, ambiguous or removed servers: ${hash(root(entries))}`, () => fixture(({ game, history }) => {
  mkdirSync(history, { recursive: true });
  const owner = Buffer.from('KAYVEL game defaults v1\n');
  for (const name of ['owner.txt', 'keys-x-c.done', 'server-play2go.done']) writeFileSync(join(history, name), owner);
  const previous = gzipSync(root(entries));
  writeFileSync(join(game, 'servers.dat'), previous);
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), previous);
  assert.deepEqual(readFileSync(join(history, 'server-play2go.done')), owner);
  assert.deepEqual(readFileSync(join(history, 'server-play2go-c9.done')), owner);
  assert.equal(readdirSync(history).some(name => name.endsWith('.bak')), false);
  applyGameDefaults(game);
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), previous);
}));

test('fresh defaults and repeat application do not create duplicate servers or backups', () => fixture(({ game, history }) => {
  applyGameDefaults(game);
  const first = readFileSync(join(game, 'servers.dat'));
  applyGameDefaults(game);
  assert.deepEqual(first, root([target]));
  assert.deepEqual(readFileSync(join(game, 'servers.dat')), first);
  assert.deepEqual(readdirSync(history).sort(), ['keys-x-c.done', 'owner.txt', 'server-play2go-c9.done', 'server-play2go.done']);
}));

test('invalid server list aborts before changing options or producing completion markers', () => fixture(({ game, history }) => {
  writeFileSync(join(game, 'options.txt'), 'original options');
  writeFileSync(join(game, 'servers.dat'), 'invalid NBT');
  assert.throws(() => applyGameDefaults(game));
  assert.equal(readFileSync(join(game, 'options.txt'), 'utf8'), 'original options');
  assert.equal(readFileSync(join(game, 'servers.dat'), 'utf8'), 'invalid NBT');
  assert.deepEqual(readdirSync(history), ['owner.txt']);
}));

for (const name of ['options.txt', 'servers.dat', '.kayvel/game-defaults-v1/owner.txt', '.kayvel/game-defaults-v1/keys-x-c.done', '.kayvel/game-defaults-v1/server-play2go.done', '.kayvel/game-defaults-v1/server-play2go-c9.done']) {
  test(`hardlinked data is rejected: ${name}`, () => fixture(({ dir, game, history }) => {
    if (name.includes('game-defaults')) {
      applyGameDefaults(game);
      unlinkSync(join(game, name));
    }
    const target = join(dir, 'outside');
    writeFileSync(target, 'keep');
    linkSync(target, join(game, name));
    assert.throws(() => applyGameDefaults(game));
    assert.equal(readFileSync(target, 'utf8'), 'keep');
  }));
}

for (const where of ['game', 'metadata', 'history']) {
  test(`directory junction is rejected: ${where}`, () => fixture(({ dir, game, metadata, history }) => {
    const target = join(dir, 'outside');
    mkdirSync(target);
    writeFileSync(join(target, 'precious'), 'keep');
    const path = { game, metadata, history }[where];
    if (existsSync(path)) rmSync(path, { recursive: true });
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => applyGameDefaults(game));
    assert.deepEqual(readdirSync(target), ['precious']);
  }));
}

test('conflicting backup is not overwritten and prevents replacing the source options', () => fixture(({ game, history }) => {
  applyGameDefaults(game);
  unlinkSync(join(history, 'keys-x-c.done'));
  const options = Buffer.from('original');
  writeFileSync(join(game, 'options.txt'), options);
  const backup = join(history, `${hash(options)}.options.txt.bak`);
  writeFileSync(backup, 'foreign');
  assert.throws(() => applyGameDefaults(game));
  assert.deepEqual(readFileSync(join(game, 'options.txt')), options);
  assert.equal(readFileSync(backup, 'utf8'), 'foreign');
}));
