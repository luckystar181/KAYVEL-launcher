import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewsStore } from '../dist/main/news.js';

test('local news creates an editable sample and reads updates without a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayvel-news-'));
  try {
    const store = createNewsStore(dir);
    const sample = await store.read();
    assert.equal(sample.length, 2);
    assert.match((await readFile(store.path, 'utf8')), /Добро пожаловать/);
    await writeFile(store.path, JSON.stringify([
      { id: 'older', date: '2026-10-01', title: 'Первая', text: 'Текст' },
      { id: 'newer', date: '2026-11-01', title: 'Вторая', text: 'Другая новость' }
    ]));
    assert.deepEqual((await store.read()).map(item => item.id), ['newer', 'older']);
    await writeFile(store.path, '{invalid');
    await assert.rejects(store.read());
  } finally { await rm(dir, { recursive: true, force: true }); }
});
