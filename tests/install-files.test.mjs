import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readZipFiles } from '../dist/main/install-files.js';

const temporary = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : process.cwd();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function archive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, contents = '', mode = 0x81a4, size } of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(size ?? bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc32(bytes), 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(size ?? bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((mode * 65536) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture(t, entries) {
  const root = await mkdtemp(join(temporary, 'kayvel-zip-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.zip');
  await writeFile(path, archive(entries));
  return { root, path };
}

test('ZIP inspection returns only selected bytes, skips directories and never extracts files', async t => {
  const { root, path } = await fixture(t, [
    { name: 'data/', mode: 0x41ed }, { name: 'data/client.lzma', contents: 'fixture patch' },
    { name: 'version.json', contents: '{"id":"fixture"}' }, { name: 'unused.txt', contents: 'unused' }
  ]);
  const files = await readZipFiles(path, name => name === 'version.json', 100);
  assert.deepEqual([...files.keys()], ['version.json']);
  assert.equal(files.get('version.json').toString(), '{"id":"fixture"}');
  assert.deepEqual(await readdir(root), ['fixture.zip']);
});

for (const entries of [
  [{ name: '../outside.txt' }], [{ name: 'mods/CON.jar' }],
  [{ name: 'linked', mode: 0xa1ff }], [{ name: 'pipe', mode: 0x11a4 }]
]) {
  test(`ZIP inspection refuses unsafe entries even when unselected: ${entries[0].name}`, async t => {
    const { path } = await fixture(t, entries);
    await assert.rejects(readZipFiles(path, () => false));
  });
}

test('ZIP inspection refuses case-insensitive duplicate selected paths', async t => {
  const { path } = await fixture(t, [{ name: 'data/a.txt' }, { name: 'data/A.txt' }]);
  await assert.rejects(readZipFiles(path, () => true), /Повторяющийся/);
});

test('ZIP inspection enforces the sum of selected uncompressed sizes', async t => {
  const { path } = await fixture(t, [{ name: 'a', contents: '123456' }, { name: 'b', contents: '123456' }]);
  await assert.rejects(readZipFiles(path, () => true, 10), /размер/);
});

test('ZIP inspection refuses invalid entry sizes and an excessive entry count', async t => {
  const { path } = await fixture(t, [{ name: 'a', contents: 'small', size: 1000 }]);
  await assert.rejects(readZipFiles(path, () => true, 10));
  const large = await fixture(t, Array.from({ length: 20_001 }, (_, i) => ({ name: `file-${i}` })));
  await assert.rejects(readZipFiles(large.path, () => false), /много записей/);
});
