import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/renderer/modpack-update-panel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });
const { ModpackUpdatePanel } = exports;
const base = { status: { state: 'available', installedVersion: 'v0.2.0-v3S', latestVersion: 'v0.2.2-v3S', message: '' }, busy: false, checking: false, lang: 'ru', onCheck: () => {}, onUpdate: () => {} };
const render = props => renderToStaticMarkup(React.createElement(ModpackUpdatePanel, { ...base, ...props }));

for (const lang of ['ru', 'en']) {
  test(`update panel shows versions and an explicit update action in ${lang}`, () => {
    const html = render({ lang });
    assert.match(html, /v0.2.0-v3S/);
    assert.match(html, /v0.2.2-v3S/);
    assert.match(html, lang === 'ru' ? />Обновить<\/button>/ : />Update<\/button>/);
    assert.match(html, lang === 'ru' ? /не запустится автоматически/ : /will not start automatically/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /disabled/);
  });
}

for (const state of ['unchecked', 'checking', 'current', 'error', 'updating', 'not-installed']) {
  test(`panel does not offer update without an available checked version: ${state}`, () => {
    assert.doesNotMatch(render({ status: { ...base.status, state } }), /class="update-button"/);
  });
}

for (const props of [{ busy: true }, { checking: true }]) {
  test(`update and check actions are disabled during other work: ${JSON.stringify(props)}`, () => {
    const buttons = render(props).match(/<button[^>]*>/g);
    assert.equal(buttons.length, 2);
    for (const button of buttons) assert.match(button, /disabled=""/);
  });
}

test('update action is explicit, calls only its callback, and status messages are escaped', () => {
  let checks = 0;
  let updates = 0;
  const element = ModpackUpdatePanel({ ...base, onCheck: () => { checks++; }, onUpdate: () => { updates++; } });
  assert.equal(checks + updates, 0);
  const actions = element.props.children[1].props.children;
  actions[1].props.onClick();
  assert.equal(updates, 1);
  assert.equal(checks, 0);
  actions[0].props.onClick();
  assert.equal(checks, 1);
  const html = render({ status: { ...base.status, state: 'error', message: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('startup invokes discovery but not application; update panel includes all busy flags', async () => {
  const app = (await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = app.indexOf('let active = true;\n    setCheckingUpdates(true);');
  assert.ok(start >= 0);
  const effect = app.slice(start, app.indexOf('}, []);', start));
  assert.match(effect, /window\.kayvel\.checkModpackUpdates\(\)/);
  assert.doesNotMatch(effect, /updateModpack\(|downloadAndPlay\(|playNeoForge\(/);
  const panel = app.match(/<ModpackUpdatePanel[^>]*onCheck=/)[0];
  for (const flag of ['gameRunning', 'preparingNeoForge', 'preparingVanilla', 'installing', 'modSwitching']) assert.ok(panel.includes('status.' + flag));
});
