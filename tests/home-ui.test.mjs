import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');

test('home menu shows the localized FFmpeg warning before the profile and launch controls', () => {
  assert.match(source, /ffmpegWarning: 'Не устанавливайте FFmpeg'/);
  assert.match(source, /ffmpegWarning: 'Do not install FFmpeg'/);
  assert.match(source, /<section className="hero">\s*<aside className="ffmpeg-warning"><span aria-hidden="true">⚠<\/span><strong>\{t\.ffmpegWarning\}<\/strong><\/aside>\s*<section className="profile-strip">/);
  assert.match(style, /\.ffmpeg-warning\{[^}]*flex:none;[^}]*border:1px solid/);
});

test('nickname field asks for the Discord-assigned name while the profile heading stays short', () => {
  assert.match(source, /nickname: 'Ник, который вам установили на Discord-сервере'/);
  assert.match(source, /nickname: 'Nickname assigned to you on the Discord server'/);
  assert.match(source, /profile: 'Профиль'/);
  assert.match(source, /profile: 'Profile'/);
  assert.match(source, /<span className="eyebrow">\{t\.profile\}<\/span><strong>\{savedNickname/);
  assert.match(source, /<label htmlFor="nickname">\{t\.nickname\}<\/label><input id="nickname"/);
  assert.match(style, /\.profile-strip \.local-test label\{[^}]*white-space:normal;[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(source, /nickname: '(?:Ник игрока|Player name)'/);
});

test('home content keeps usable dark scrollbars during first download in small windows', () => {
  assert.match(style, /\*\{[^}]*scrollbar-width:thin;scrollbar-color:#76505f #18121a/);
  assert.match(style, /html,body,#root\{[^}]*color-scheme:dark/);
  assert.match(style, /::-webkit-scrollbar\{width:10px;height:10px\}/);
  assert.match(style, /::-webkit-scrollbar-track,::-webkit-scrollbar-corner\{background:#18121a\}/);
  assert.match(style, /::-webkit-scrollbar-thumb\{background:#76505f;/);
  assert.match(style, /\.hero\{overflow-y:auto\}/);
  assert.doesNotMatch(style, /\.hero(?:::-webkit-scrollbar)?\{[^}]*(?:overflow(?:-y)?:hidden|scrollbar-width:none|display:none)/);
});

test('both footer translations match the packaged launcher version', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(source.includes(`version: 'Версия лаунчера ${version} · v3S'`));
  assert.ok(source.includes(`version: 'Launcher ${version} · v3S'`));
});
