import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import * as React from 'react';

const app = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
const guide = await readFile(new URL('../src/renderer/skin-guide.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(guide, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
const exports = {};
runInNewContext(outputText, { exports, require: name => { assert.equal(name, 'react'); return React; } });

test('server skin guide has a top navigation entry and a native modal with keyboard support', () => {
  const nav = app.slice(app.indexOf('<nav className="top-tabs"'), app.indexOf('</nav>'));
  assert.match(nav, /Гайд по скину/);
  assert.match(nav, /Skin guide/);
  assert.match(nav, /aria-haspopup="dialog"/);
  assert.match(nav, /setGameOpen\(false\); setSkinGuideOpen\(true\)/);
  assert.match(app, /skinGuideOpen && <SkinGuide lang=\{lang\} onClose=/);
  assert.match(guide, /element\.showModal\(\)/);
  assert.match(guide, /previous\.focus\(\)/);
  assert.match(guide, /onCancel=/);
});

for (const lang of ['ru', 'en']) {
  test(`server skin guide renders the hosting steps and exact command examples in ${lang}`, () => {
    const markup = renderToStaticMarkup(React.createElement(exports.SkinGuide, { lang, onClose() {} }));
    assert.match(markup, /<dialog[^>]+aria-labelledby="skin-guide-title"/);
    assert.equal((markup.match(/<li>/g) || []).length, 4);
    assert.match(markup, /64×64/);
    assert.match(markup, /https:\/\/i\.postimg\.cc/);
    assert.match(markup, /Direct link/);
    assert.match(markup, /\/skin set web classic &quot;https:\/\/i\.postimg\.cc\/XXXX\/skin\.png&quot;/);
    assert.match(markup, /\/skin set web slim &quot;https:\/\/i\.postimg\.cc\/XXXX\/skin\.png&quot;/);
    for (const link of ['postimages', 'modrinth', 'commands']) assert.ok(markup.includes(`data-guide-link="${link}"`));
    assert.doesNotMatch(markup, /<img|<iframe|<input|<canvas/);
    assert.match(markup, lang === 'ru' ? /игроку не нужно скачивать его в клиент/ : /players do not need to download it to their client/);
    assert.match(markup, lang === 'ru' ? /не меняет файлы игры или профиль/ : /change game files or your profile/);
  });
}
