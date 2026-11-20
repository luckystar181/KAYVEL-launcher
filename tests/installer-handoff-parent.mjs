import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openUpdateInstaller } from '../dist/main/installer-handoff.js';

const [executable, root, mode] = process.argv.slice(2);
const timeout = setTimeout(() => process.exit(2), 25_000);
if (mode === 'no-ack' || mode === 'parent-alive') {
  const child = spawn(executable, ['--kayvel-update', `--parent-pid=${process.pid}`], {
    shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let message = '';
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    message += chunk.toString();
    if (message === 'KAYVEL_SETUP_READY_V1\n' && mode === 'parent-alive') child.stdin.write('KAYVEL_SETUP_QUIT_V1\n');
  });
  child.once('error', () => process.exit(5));
  child.once('exit', code => {
    const rejected = existsSync(join(root, 'rejected.txt')) && !existsSync(join(root, 'completed.txt'));
    if (code === 1 && rejected) writeFileSync(join(root, 'parent-alive.txt'), 'fixture parent was not terminated');
    clearTimeout(timeout);
    process.exit(code === 1 && rejected ? 0 : 6);
  });
} else await openUpdateInstaller(executable, {
  canQuit: async () => { if (mode === 'reject') throw new Error('fixture process guard'); },
  quit: () => {
    writeFileSync(join(root, 'quit-requested.txt'), 'only fixture parent exits');
    setTimeout(() => {
      const premature = existsSync(join(root, 'completed.txt'));
      clearTimeout(timeout);
      process.exit(premature || mode !== 'success' ? 3 : 0);
    }, 250);
  },
  ended: () => { clearTimeout(timeout); process.exit(mode === 'reject' ? 0 : 4); }
});
