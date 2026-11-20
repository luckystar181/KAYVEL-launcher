import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/renderer/launcher-update-panel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });
const { LauncherUpdatePanel } = exports;

for (const lang of ['ru', 'en']) {
  test(`unpublished launcher channel has a neutral localized status and no install action: ${lang}`, () => {
    const html = renderToStaticMarkup(React.createElement(LauncherUpdatePanel, {
      lang, busy: false, status: { state: 'unavailable', installedVersion: '0.2.7', latestVersion: null, message: '' },
      onCheck: () => assert.fail('Rendering must not check'), onUpdate: () => assert.fail('Rendering must not update')
    }));
    assert.match(html, lang === 'ru' ? /Канал обновлений пока недоступен/ : /Update channel is not available yet/);
    assert.match(html, lang === 'ru' ? /Актуальность версии не подтверждена/ : /Version freshness is unconfirmed/);
    assert.match(html, /0.2.7/);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.doesNotMatch(html, /404|HTTP|Лаунчер актуален|Launcher is up to date|disabled/);
  });
}
