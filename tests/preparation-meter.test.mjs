import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/renderer/preparation-meter.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });
const { PreparationMeter } = exports;
const base = { stage: 'minecraft', file: 'libraries/fixture.jar', received: 1_048_576, total: 4_194_304, completedFiles: 2, totalFiles: 8 };
const render = (progress, lang = 'ru') => renderToStaticMarkup(React.createElement(PreparationMeter, { progress, lang }));

test('preparation meter renders actual byte totals, file counts and percentage', () => {
  const html = render(base);
  assert.match(html, /Minecraft 1.21.1/);
  assert.match(html, /25%/);
  assert.match(html, /max="4194304" value="1048576"/);
  assert.match(html, /1.0 MiB \/ 4.0 MiB/);
  assert.match(html, /2 \/ 8 файлов/);
});

test('unknown totals use indeterminate progress without a fabricated percentage', () => {
  const html = render({ ...base, total: null, totalFiles: null });
  assert.match(html, /Общий объём пока неизвестен/);
  const progress = /<progress[^>]*>/.exec(html)[0];
  assert.doesNotMatch(progress, /value=|max=/);
  assert.doesNotMatch(html, /\d+%|файлов/);
});

test('verification retains actual file counts without inventing byte totals', () => {
  const html = render({ ...base, stage: 'verify', total: null, received: 0 }, 'en');
  assert.match(html, /Verifying files/);
  assert.match(html, /2 \/ 8 files/);
  assert.match(html, /Total size is not yet known/);
  assert.doesNotMatch(html, /\d+%/);
});

test('smooth visual meter retains accessible real progress and never fabricates unknown percentages', async () => {
  assert.match(render(base), /class="preparation-track measured" aria-hidden="true"/);
  assert.match(render(base), /transform:scaleX\(0.25\)/);
  assert.match(render({ ...base, total: null }), /preparation-track indeterminate/);
  assert.match(render(base), /progress class="sr-only"/);
  const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /preparation-glide 2.6s ease-in-out infinite alternate/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('preparation meter escapes filenames and handles an empty stage without NaN', () => {
  const html = render({ ...base, stage: 'java', total: 0, received: 0, file: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img|NaN|Infinity/);
  assert.match(html, /&lt;img/);
});
