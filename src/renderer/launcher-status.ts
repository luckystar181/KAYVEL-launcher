import type { PreparationProgress } from '../main/preparation-progress';

type GameExit = { code: number | null; gamePath: string };
type LiveStatus = { gameRunning: boolean; preparationProgress: PreparationProgress | null };

export function watchLauncherStatus<T extends LiveStatus>(
  api: {
    status(): Promise<T>;
    onPreparationProgress(callback: (progress: PreparationProgress | null) => void): () => void;
    onGameExit(callback: (exit: GameExit) => void): () => void;
  },
  callbacks: { status(value: T): void; progress(value: PreparationProgress | null): void; exit(value: GameExit): void; error(): void },
  host: Pick<Window, 'setInterval' | 'clearInterval' | 'addEventListener' | 'removeEventListener'> = window
): () => void {
  let active = true;
  let pending = false;
  let revision = 0;
  async function refresh() {
    if (!active || pending) return;
    pending = true;
    const started = revision;
    try {
      const value = await api.status();
      if (active && started === revision) {
        callbacks.status(value);
        callbacks.progress(value.gameRunning ? null : value.preparationProgress);
      }
    } catch { if (active) callbacks.error(); }
    finally { pending = false; }
  }
  const unsubscribeProgress = api.onPreparationProgress(value => {
    revision++;
    callbacks.progress(value);
    void refresh();
  });
  const unsubscribeExit = api.onGameExit(value => {
    revision++;
    callbacks.progress(null);
    callbacks.exit(value);
    void refresh();
  });
  const timer = host.setInterval(() => void refresh(), 1000);
  const focus = () => { void refresh(); };
  host.addEventListener('focus', focus);
  void refresh();
  return () => {
    active = false;
    host.clearInterval(timer);
    host.removeEventListener('focus', focus);
    unsubscribeProgress();
    unsubscribeExit();
  };
}
