import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPreviewImage, supportedSkinHeadSize } from '../src/renderer/skin-preview-helpers.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('head preview accepts both supported 64-pixel PNG layouts', () => {
  assert.equal(supportedSkinHeadSize(64, 32), true);
  assert.equal(supportedSkinHeadSize(64, 64), true);
  assert.equal(supportedSkinHeadSize(128, 128), true);
  for (const [width, height] of [[64, 16], [32, 64], [128, 64], [1, 1]]) {
    assert.equal(supportedSkinHeadSize(width, height), false);
  }
});

test('an older 3D preview cannot replace the current one when decoding finishes later', async () => {
  const first = deferred();
  const second = deferred();
  const shown = [];
  const closed = [];
  const errors = [];
  const cancelFirst = loadPreviewImage(new Blob(), () => first.promise, image => shown.push(image.name), () => errors.push('first'));
  cancelFirst();
  loadPreviewImage(new Blob(), () => second.promise, image => shown.push(image.name), () => errors.push('second'));
  second.resolve({ name: 'new', close: () => closed.push('new') });
  await flush();
  first.resolve({ name: 'old', close: () => closed.push('old') });
  await flush();
  assert.deepEqual(shown, ['new']);
  assert.deepEqual(closed, ['new', 'old']);
  assert.deepEqual(errors, []);
});

test('errors from an obsolete 3D preview are ignored; active errors are reported', async () => {
  const first = deferred();
  const second = deferred();
  const errors = [];
  const cancelFirst = loadPreviewImage(new Blob(), () => first.promise, () => assert.fail(), () => errors.push('first'));
  cancelFirst();
  loadPreviewImage(new Blob(), () => second.promise, () => assert.fail(), () => errors.push('second'));
  first.reject(new Error('old error'));
  second.reject(new Error('current error'));
  await flush();
  assert.deepEqual(errors, ['second']);
});

test('a decoded image is closed even if drawing the active preview fails', async () => {
  let closed = 0;
  let errors = 0;
  loadPreviewImage(new Blob(), async () => ({ close: () => closed++ }), () => { throw new Error('draw error'); }, () => errors++);
  await flush();
  assert.equal(closed, 1);
  assert.equal(errors, 1);
});
