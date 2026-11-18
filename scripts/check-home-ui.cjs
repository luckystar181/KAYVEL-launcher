const { app, BrowserWindow, session } = require('electron');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');

const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-home-ui-'));
app.setPath('userData', root);
app.setPath('sessionData', root);
app.on('window-all-closed', () => {});
const renderer = resolve(process.argv[2] || join(__dirname, '../dist/renderer/index.html'));
const phases = process.argv[3] ? [process.argv[3]] : ['ready', 'discovery', 'download', 'cancelling', 'error'];
assert.ok(phases.every(phase => ['ready', 'discovery', 'download', 'cancelling', 'error'].includes(phase)));
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const preload = join(root, 'fixture-preload.cjs');
writeFileSync(preload, `
const { contextBridge } = require('electron');
const phase = process.argv.find(value => value.startsWith('--kayvel-ui-phase=')).split('=')[1];
const active = ['discovery', 'download', 'cancelling'].includes(phase);
const modpackUpdate = { state: phase === 'ready' ? 'current' : 'not-installed', installedVersion: phase === 'ready' ? 'v0.2.0-v3S' : null, latestVersion: 'v0.2.0-v3S', message: '' };
const preparationProgress = phase === 'ready' ? null : { stage: phase === 'discovery' ? 'discovery' : phase === 'error' ? 'error' : 'minecraft', received: 123456789, total: phase === 'discovery' || phase === 'error' ? null : 345678901, completedFiles: 123, totalFiles: 456, file: phase === 'error' ? 'Соединение прервано / Connection interrupted. '.repeat(12) : 'libraries/net/minecraft/' + 'long-file-name-'.repeat(20) + '.jar' };
const status = { downloadActive: active, downloadCancelling: phase === 'cancelling', preparationIncomplete: phase !== 'ready', releaseConfigured: true, gamePath: 'isolated-fixture', vanillaPath: 'isolated-fixture', vanillaReady: phase === 'ready', preparingVanilla: active, neoforgeReady: phase === 'ready', preparingNeoForge: false, gameRunning: false, installing: false, modSwitching: false, modpackUpdate, preparationProgress };
contextBridge.exposeInMainWorld('kayvel', {
  status: async () => status,
  checkModpackUpdates: async () => modpackUpdate,
  memorySettings: async () => ({ memoryMb: 4096, minMemoryMb: 2048, maxMemoryMb: 8192, totalMemoryMb: 16384 }),
  localProfile: async () => ({ nickname: 'Discord_Name', skin: null }),
  gameBest: async () => 0,
  modSwitches: async () => [],
  onPreparationProgress: () => () => {},
  onGameExit: () => () => {}
});
`, { flag: 'wx' });

const timeout = setTimeout(() => { console.error('UI smoke timed out:', root); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  const isolated = session.fromPartition('kayvel-home-ui', { cache: false });
  const blocked = [];
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !details.url.startsWith('file:');
    if (cancel) blocked.push(details.url);
    callback({ cancel });
  });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const errors = [];
  for (const phase of phases) {
    const window = new BrowserWindow({ width: 1100, height: 720, frame: false, show: false, backgroundColor: '#100f13', webPreferences: { preload, session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, additionalArguments: ['--kayvel-ui-phase=' + phase] } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await window.loadFile(renderer);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        if (document.querySelector('#nickname')?.value === 'Discord_Name' && document.querySelector('.play')?.textContent.includes(${JSON.stringify(phase === 'ready' ? 'ИГРАТЬ' : 'Повторить загрузку')})) return resolve(true);
        if (++attempts > 100) return reject(new Error('Profile/status fixture did not load'));
        setTimeout(check, 30);
      };
      check();
    })`);
    for (const language of ['ru', 'en']) {
      if (language === 'en') {
        await window.webContents.executeJavaScript(`document.querySelector('.settings').click()`);
        await window.webContents.executeJavaScript(`const select = document.querySelector('#language'); select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true }));`);
        await window.webContents.executeJavaScript(`document.querySelector('.text-button').click()`);
      }
      for (const [width, height] of [[1440, 820], [1100, 720], [800, 600]]) {
        window.setContentSize(width, height);
        await window.webContents.executeJavaScript(`document.querySelector('.hero').scrollTop = 0`);
        const result = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const hero = document.querySelector('.hero');
          const warning = document.querySelector('.ffmpeg-warning');
          const label = document.querySelector('label[for="nickname"]');
          const bounds = warning.getBoundingClientRect();
          const style = getComputedStyle(hero);
          const control = document.querySelector('.download-controls button');
          resolve({ warning: warning.textContent.trim(), label: label.textContent, labelFits: label.scrollHeight <= label.clientHeight + 1, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || hero.scrollWidth > hero.clientWidth, warningVisible: bounds.top >= 0 && bounds.bottom <= innerHeight, footer: document.querySelector('.footer-version').textContent, nickname: document.querySelector('#nickname').value, scrolling: hero.scrollHeight > hero.clientHeight, scrollbarColor: style.scrollbarColor, colorScheme: style.colorScheme, cancelVisible: Boolean(control), cancelDisabled: control?.disabled, progressVisible: Boolean(document.querySelector('.preparation-meter')), indeterminate: Boolean(document.querySelector('.preparation-track.indeterminate')), documentFits: document.documentElement.scrollHeight <= innerHeight });
        })))`);
        assert.equal(result.warning, language === 'ru' ? '⚠Не устанавливайте FFmpeg' : '⚠Do not install FFmpeg');
        assert.equal(result.label, language === 'ru' ? 'Ник, который вам установили на Discord-сервере' : 'Nickname assigned to you on the Discord server');
        assert.ok(result.labelFits, 'Nickname label must not be clipped');
        assert.equal(result.horizontalOverflow, false, 'Home menu must not overflow horizontally');
        assert.ok(result.warningVisible, 'Warning must be visible without scrolling');
        assert.ok(result.documentFits, 'Only the home content should scroll, not the document');
        assert.equal(result.scrollbarColor, 'rgb(118, 80, 95) rgb(24, 18, 26)', 'Scrollbar thumb and track must match the dark interface');
        assert.equal(result.colorScheme, 'dark', 'Native controls must use the dark color scheme');
        assert.ok(result.footer.includes(version));
        assert.equal(result.nickname, 'Discord_Name');
        assert.equal(result.cancelVisible, ['discovery', 'download', 'cancelling'].includes(phase));
        if (result.cancelVisible) assert.equal(result.cancelDisabled, phase === 'cancelling');
        assert.equal(result.progressVisible, phase !== 'ready');
        if (result.progressVisible) assert.equal(result.indeterminate, phase === 'discovery' || phase === 'error');
        if (width === 1100 || (width === 800 && phase !== 'ready')) writeFileSync(join(root, `home-${phase}-${language}-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
        if (result.scrolling) {
          console.log('Scrollbar:', phase, language, width, result.scrollbarColor, result.colorScheme);
          const reached = await window.webContents.executeJavaScript(`new Promise(resolve => {
            const hero = document.querySelector('.hero');
            hero.scrollTop = hero.scrollHeight;
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
              const bounds = hero.getBoundingClientRect();
              const visible = element => {
                if (!element) return false;
                const target = element.getBoundingClientRect();
                return target.height > 0 && target.bottom <= bounds.bottom + 1 && target.top >= bounds.top;
              };
              resolve({ scrolled: hero.scrollTop > 0, last: visible(hero.lastElementChild), progress: visible(document.querySelector('.preparation-meter')), cancel: visible(document.querySelector('.download-controls button')) });
            }, 120)));
          })`);
          assert.ok(reached.scrolled && reached.last, 'Last home element must remain reachable by scrolling');
          if (result.progressVisible) assert.ok(reached.progress, 'Progress must be visible after scrolling');
          if (result.cancelVisible) assert.ok(reached.cancel, 'Cancel button must be visible after scrolling');
          if (width === 800 && phase !== 'ready') writeFileSync(join(root, `home-${phase}-${language}-${width}x${height}-scrolled.png`), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
        }
        console.log(`PASS: ${phase} ${language} ${width}x${height}: warning, nickname, progress, controls and layout`);
      }
    }
    window.destroy();
  }
  assert.deepEqual(blocked, [], 'UI must not attempt network requests');
  assert.deepEqual(errors, [], 'Renderer must not log errors');
  console.log('Isolated UI screenshots:', root);
}).then(() => { clearTimeout(timeout); app.exit(0); }, error => { console.error(error); clearTimeout(timeout); app.exit(1); });
