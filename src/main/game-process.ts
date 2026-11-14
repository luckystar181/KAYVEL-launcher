import type { ChildProcess } from 'node:child_process';

export type GameExit = { code: number | null; gamePath: string };

export function createGameExitReporter(gamePath: string, notify: (exit: GameExit) => void): (code: number | null) => void {
  let reported = false;
  return code => {
    if (reported) return;
    reported = true;
    notify({ code: code === null ? null : code | 0, gamePath });
  };
}

export function watchLockedGame(
  child: ChildProcess,
  releaseLock: () => Promise<void>,
  onExit: (code: number | null) => void,
  onError: (error: unknown) => void
): void {
  let finished = false;
  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    void (async () => {
      try { await releaseLock(); }
      catch (error) { onError(error); }
      finally { onExit(code); }
    })();
  };
  child.once('exit', code => finish(code));
  child.on('error', error => {
    onError(error);
    if (child.pid === undefined) finish(-1);
  });
  if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
}
