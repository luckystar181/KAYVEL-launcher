const { app, BrowserWindow, session } = require('electron');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');

const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'kayvel-home-ui-'));
app.setPath('userData', root);
app.setPath('sessionData', root);
app.on('window-all-closed', () => {});
const renderer = resolve(process.argv[2] || join(__dirname, '../dist/renderer/index.html'));
const phases = process.argv[3] ? [process.argv[3]] : ['ready', 'unavailable', 'discovery', 'download', 'cancelling', 'error'];
assert.ok(phases.every(phase => ['ready', 'unavailable', 'discovery', 'download', 'cancelling', 'error'].includes(phase)));
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const preload = join(root, 'fixture-preload.cjs');
writeFileSync(preload, `
const { contextBridge } = require('electron');
const phase = process.argv.find(value => value.startsWith('--kayvel-ui-phase=')).split('=')[1];
const active = ['discovery', 'download', 'cancelling'].includes(phase);
const ready = ['ready', 'unavailable'].includes(phase);
const modpackUpdate = { state: ready ? 'current' : 'not-installed', installedVersion: ready ? 'v0.2.0-v3S' : null, latestVersion: 'v0.2.0-v3S', message: '' };
const preparationProgress = ready ? null : { stage: phase === 'discovery' ? 'discovery' : phase === 'error' ? 'error' : 'minecraft', received: 123456789, total: phase === 'discovery' || phase === 'error' ? null : 345678901, completedFiles: 123, totalFiles: 456, file: phase === 'error' ? 'Соединение прервано / Connection interrupted. '.repeat(12) : 'libraries/net/minecraft/' + 'long-file-name-'.repeat(20) + '.jar' };
const launcherUpdate = { state: phase === 'unavailable' ? 'unavailable' : 'available', installedVersion: '0.2.7', latestVersion: phase === 'unavailable' ? null : '0.2.8', message: '' };
const status = { launcherUpdate, downloadActive: active, downloadCancelling: phase === 'cancelling', preparationIncomplete: !ready, releaseConfigured: true, gamePath: 'isolated-fixture', vanillaPath: 'isolated-fixture', vanillaReady: ready, preparingVanilla: active, neoforgeReady: ready, preparingNeoForge: false, gameRunning: false, installing: false, modSwitching: false, modpackUpdate, preparationProgress };
const guideCalls = [];
contextBridge.exposeInMainWorld('kayvel', {
  openGuideLink: async id => { guideCalls.push(id); return { ok: id !== 'modrinth', message: '' }; },
  guideCalls: async () => [...guideCalls],
  status: async () => status,
  checkLauncherUpdates: async () => launcherUpdate,
  checkModpackUpdates: async () => modpackUpdate,
  memorySettings: async () => ({ memoryMb: 4096, minMemoryMb: 2048, maxMemoryMb: 8192, totalMemoryMb: 16384 }),
  localProfile: async () => ({ nickname: 'Discord_Name' }),
  gameBest: async () => 0,
  modSwitches: async () => [],
  onPreparationProgress: () => () => {},
  onGameExit: () => () => {}
});
`, { flag: 'wx' });

const timeout = setTimeout(() => { console.error('UI smoke timed out:', root); app.exit(1); }, 360000);
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
        if (document.querySelector('#nickname')?.value === 'Discord_Name' && document.querySelector('.play')?.textContent.includes(${JSON.stringify(['ready', 'unavailable'].includes(phase) ? 'ИГРАТЬ' : 'Повторить загрузку')})) return resolve(true);
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
          const style = getComputedStyle(hero);
          const control = document.querySelector('.download-controls button');
          const brand = document.querySelector('.brand-display').getBoundingClientRect();
          const updates = document.querySelector('.home-updates');
          resolve({ brandVisible: brand.height > 0, skinControls: Boolean(document.querySelector('input[type="file"], canvas, .skin-preview, .skin-upload')), updatesCollapsed: !updates.open, updateNotice: updates.querySelector('summary').textContent, warning: Boolean(warning), launcherPanel: Boolean(document.querySelector('.launcher-update')), label: label.textContent, labelFits: label.scrollHeight <= label.clientHeight + 1, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || hero.scrollWidth > hero.clientWidth, footer: document.querySelector('.footer-version').textContent, nickname: document.querySelector('#nickname').value, scrolling: hero.scrollHeight > hero.clientHeight, scrollbarColor: style.scrollbarColor, colorScheme: style.colorScheme, cancelVisible: Boolean(control), cancelDisabled: control?.disabled, progressVisible: Boolean(document.querySelector('.preparation-meter')), indeterminate: Boolean(document.querySelector('.preparation-track.indeterminate')), documentFits: document.documentElement.scrollHeight <= innerHeight });
        })))`);
        assert.equal(result.warning, false);
        assert.ok(result.brandVisible, 'Brand must remain visible');
        assert.equal(result.skinControls, false, 'No local skin controls or preview should remain');
        assert.ok(result.updatesCollapsed, 'Update details must start collapsed');
        assert.ok(result.updateNotice.includes(phase === 'unavailable' ? (language === 'ru' ? 'Сборка и лаунчер' : 'Modpack and launcher') : (language === 'ru' ? 'Доступно обновление' : 'Update available')));
        assert.equal(result.launcherPanel, true);
        assert.equal(result.label, language === 'ru' ? 'Ник, который вам установили на Discord-сервере' : 'Nickname assigned to you on the Discord server');
        assert.ok(result.labelFits, 'Nickname label must not be clipped');
        assert.equal(result.horizontalOverflow, false, 'Home menu must not overflow horizontally');
        assert.ok(result.documentFits, 'Only the home content should scroll, not the document');
        assert.equal(result.scrollbarColor, 'rgb(118, 80, 95) rgb(24, 18, 26)', 'Scrollbar thumb and track must match the dark interface');
        assert.equal(result.colorScheme, 'dark', 'Native controls must use the dark color scheme');
        assert.ok(result.footer.includes(version));
        assert.equal(result.nickname, 'Discord_Name');
        assert.equal(result.cancelVisible, ['discovery', 'download', 'cancelling'].includes(phase));
        if (result.cancelVisible) assert.equal(result.cancelDisabled, phase === 'cancelling');
        assert.equal(result.progressVisible, !['ready', 'unavailable'].includes(phase));
        if (result.progressVisible) assert.equal(result.indeterminate, phase === 'discovery' || phase === 'error');
        if (width === 1100 || width === 800) writeFileSync(join(root, `home-${phase}-${language}-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
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
        const expanded = await window.webContents.executeJavaScript(`new Promise(resolve => {
          const updates = document.querySelector('.home-updates');
          updates.querySelector('summary').click();
          document.querySelector('.launcher-update').scrollIntoView({ block: 'end' });
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const panel = document.querySelector('.launcher-update');
            const rect = panel.getBoundingClientRect();
            const hero = document.querySelector('.hero').getBoundingClientRect();
            resolve({ open: updates.open, visible: rect.height > 0 && rect.top >= hero.top && rect.bottom <= hero.bottom + 1, text: panel.textContent, horizontalOverflow: document.querySelector('.hero').scrollWidth > document.querySelector('.hero').clientWidth });
          }));
        })`);
        assert.ok(expanded.open && expanded.visible, 'Launcher panel must remain reachable when expanded');
        assert.equal(expanded.horizontalOverflow, false);
        if (phase === 'unavailable') {
          assert.ok(expanded.text.includes(language === 'ru' ? 'Канал обновлений пока недоступен' : 'Update channel is not available yet'));
          assert.ok(expanded.text.includes(language === 'ru' ? 'Актуальность версии не подтверждена' : 'Version freshness is unconfirmed'));
          assert.doesNotMatch(expanded.text, /404|HTTP|Лаунчер актуален|Launcher is up to date/);
        }
        if (width === 800 && ['ready', 'unavailable'].includes(phase)) writeFileSync(join(root, `home-${phase}-${language}-${width}x${height}-updates.png`), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
        await window.webContents.executeJavaScript(`document.querySelector('.home-updates summary').click(); document.querySelector('.hero').scrollTop = 0;`);
        await window.webContents.executeJavaScript(`{ const trigger = document.querySelector('.top-tabs button[aria-haspopup="dialog"]'); trigger.focus(); trigger.click(); }`);
        const guide = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const dialog = document.querySelector('.skin-guide');
          const body = document.querySelector('.skin-guide-body');
          const rect = dialog.getBoundingClientRect();
          const nav = document.querySelector('.top-tabs').getBoundingClientRect();
          const edition = document.querySelector('.edition').getBoundingClientRect();
          resolve({ modal: dialog.matches(':modal'), title: document.querySelector('#skin-guide-title').textContent, focused: document.activeElement === dialog.querySelector('.game-close'), steps: dialog.querySelectorAll('li').length, fits: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth, noOverflow: body.scrollWidth <= body.clientWidth && document.documentElement.scrollWidth <= innerWidth, navFits: nav.left >= edition.right, text: body.textContent, commands: [...dialog.querySelectorAll('code')].map(node => node.textContent) });
        })))`);
        assert.ok(guide.modal && guide.focused, 'Guide must be a modal with initial focus on close');
        assert.ok(guide.fits && guide.noOverflow && guide.navFits, 'Guide and top navigation must fit every window size');
        assert.equal(guide.steps, 4);
        assert.equal(guide.title, language === 'ru' ? 'Как установить скин на сервере' : 'How to set your server skin');
        assert.deepEqual(guide.commands, ['/skin set web classic "https://i.postimg.cc/XXXX/skin.png"', '/skin set web slim "https://i.postimg.cc/XXXX/skin.png"']);
        assert.ok(guide.text.includes('Direct link'));
        if (width === 800 || width === 1100) writeFileSync(join(root, `guide-${phase}-${language}-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG(), { flag: 'wx' });
        const guideBottom = await window.webContents.executeJavaScript(`new Promise(resolve => {
          const body = document.querySelector('.skin-guide-body'); body.scrollTop = body.scrollHeight;
          requestAnimationFrame(() => { const last = body.querySelector('.skin-guide-note').getBoundingClientRect(); const rect = body.getBoundingClientRect(); resolve(last.top >= rect.top && last.bottom <= rect.bottom + 1); });
        })`);
        assert.ok(guideBottom, 'Guide end must be reachable by scrolling');
        if (phase === 'ready' && width === 800) {
          for (const id of ['postimages', 'modrinth', 'commands']) await window.webContents.executeJavaScript(`document.querySelector('[data-guide-link="${id}"]').click()`);
          const links = await window.webContents.executeJavaScript(`(async () => ({ calls: await window.kayvel.guideCalls(), error: Boolean(document.querySelector('.skin-guide [role="alert"]')) }))()`);
          assert.deepEqual(links.calls.slice(-3), ['postimages', 'modrinth', 'commands']);
          assert.equal(links.error, false);
          await window.webContents.executeJavaScript(`document.querySelector('[data-guide-link="modrinth"]').click()`);
          assert.ok(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.skin-guide [role="alert"]'))`), 'Failed browser open must show a fallback message');
        }
        await window.webContents.executeJavaScript(`document.querySelector('.skin-guide .game-close').click()`);
        assert.ok(await window.webContents.executeJavaScript(`!document.querySelector('.skin-guide') && document.activeElement === document.querySelector('.top-tabs button[aria-haspopup="dialog"]')`), 'Closing must restore focus to the guide entry');
        await window.webContents.executeJavaScript(`document.querySelector('.top-tabs button[aria-haspopup="dialog"]').click()`);
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        assert.ok(await window.webContents.executeJavaScript(`!document.querySelector('.skin-guide')`), 'Escape must close the guide');
        console.log(`PASS: ${phase} ${language} ${width}x${height}: home layout, guide, commands, scrolling, focus and Escape`);
      }
    }
    window.destroy();
  }
  assert.deepEqual(blocked, [], 'UI must not attempt network requests');
  assert.deepEqual(errors, [], 'Renderer must not log errors');
  console.log('Isolated UI screenshots:', root);
}).then(() => { clearTimeout(timeout); app.exit(0); }, error => { console.error(error); clearTimeout(timeout); app.exit(1); });
