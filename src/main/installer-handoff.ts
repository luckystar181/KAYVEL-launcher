import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type InstallerHandoffCallbacks = {
  canQuit: () => Promise<void>;
  quit: () => void;
  ended: (error: Error) => void;
};

export async function openUpdateInstaller(executable: string, callbacks: InstallerHandoffCallbacks,
    start: typeof spawn = spawn): Promise<void> {
  // The installer must survive the Windows parent's exit, while retaining its private pipes.
  const child = start(executable, ['--kayvel-update', `--parent-pid=${process.pid}`], {
    shell: false, detached: true, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  let active = true;
  let ready = false;
  let message = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: Error) => {
    if (!active) return;
    active = false;
    clearTimeout(deadline);
    child.stdin.destroy();
    callbacks.ended(error);
  };
  child.stdin.on('error', () => fail(new Error('Связь с установщиком закрыта. Старый лаунчер сохранён.')));
  child.stdout.on('error', () => fail(new Error('Не удалось получить ответ установщика.')));
  child.stdout.once('end', () => fail(new Error('Установщик закрыл канал перехода. Старый лаунчер продолжает работать.')));
  child.stderr.on('error', () => fail(new Error('Связь с установщиком прервана.')));
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    if (!active) return;
    if (ready || chunk.length > 64 || message.length + chunk.length > 64 || [...chunk].some(byte => byte !== 10 && (byte < 32 || byte > 126))) {
      fail(new Error('Неизвестный ответ установщика. Автоматический переход отменён.'));
      return;
    }
    message += chunk.toString('ascii');
    if (!message.includes('\n')) return;
    if (message !== 'KAYVEL_SETUP_READY_V1\n') {
      fail(new Error('Установщик не подтвердил успешную установку.'));
      return;
    }
    ready = true;
    deadline = setTimeout(() => fail(new Error('Время подтверждения перехода истекло. Старый лаунчер продолжает работать.')), 10_000);
    deadline.unref();
    void Promise.resolve().then(() => callbacks.canQuit()).then(() => {
      if (!active) return;
      child.stdin.write('KAYVEL_SETUP_QUIT_V1\n', error => {
        if (error) { fail(new Error('Не удалось подтвердить переход на новую версию.')); return; }
        if (!active) return;
        active = false;
        clearTimeout(deadline);
        callbacks.quit();
      });
    }).catch(() => fail(new Error('Переход заблокирован: игра или другая операция ещё выполняется. Закройте установщик и повторите обновление.')));
  });
  child.once('exit', () => fail(new Error('Установщик закрыт. Старый лаунчер продолжает работать.')));
  await new Promise<void>((resolve, reject) => {
    let started = false;
    child.once('spawn', () => { started = true; resolve(); });
    child.on('error', () => {
      const error = new Error('Не удалось открыть проверенный установщик.');
      if (started) fail(error);
      else { active = false; reject(error); }
    });
  });
}
