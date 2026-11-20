import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/app.tsx', import.meta.url), 'utf8');
const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');

test('home menu no longer warns against FFmpeg and includes launcher update controls', () => {
  assert.doesNotMatch(source, /ffmpegWarning|ffmpeg-warning|Не устанавливайте FFmpeg|Do not install FFmpeg/);
  assert.doesNotMatch(style, /ffmpeg-warning/);
  assert.match(source, /<section className="hero">\s*<section className="profile-strip">/);
  assert.match(source, /<LauncherUpdatePanel/);
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

test('home keeps a single-column brand and update details collapsed without hiding progress', () => {
  assert.match(source, /<details className=\{`home-updates/);
  const details = source.slice(source.indexOf('<details className={`home-updates'), source.indexOf('</details>'));
  assert.doesNotMatch(details, /\bopen[= >]/);
  assert.match(details, /<summary>/);
  assert.match(details, /<ModpackUpdatePanel/);
  assert.match(details, /<LauncherUpdatePanel/);
  assert.doesNotMatch(details, /PreparationMeter|download-controls/);
  assert.match(source, /updateAvailable = status\?\.modpackUpdate.state === 'available' \|\| status\?\.launcherUpdate.state === 'available'/);
  assert.match(style, /\.home-showcase\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(source + style, /saveLocalSkin|applyLocalSkin|skin-preview|skin-upload|input\[type="file"\]|canvas/i);
  assert.doesNotMatch(source, /brand-diamond|Java → Minecraft → NeoForge/);
});

test('both footer translations match the packaged launcher version', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(source.includes(`version: 'Версия лаунчера ${version} · v3S'`));
  assert.ok(source.includes(`version: 'Launcher ${version} · v3S'`));
});
