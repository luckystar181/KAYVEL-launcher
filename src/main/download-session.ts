import { AsyncLocalStorage } from 'node:async_hooks';

const signals = new AsyncLocalStorage<AbortSignal>();
let request: typeof fetch = (...args) => fetch(...args);

export const cancellationMessage = 'Загрузка отменена. Файлы сохранены; повтор возможен только по вашей команде.';

export function configureDownloadRequest(value: typeof fetch): void { request = value; }
export function currentDownloadRequest(): typeof fetch { return request; }
export function downloadSignal(): AbortSignal | undefined { return signals.getStore(); }
export function checkDownloadCancelled(): void { downloadSignal()?.throwIfAborted(); }
export function withDownloadSignal<T>(signal: AbortSignal, action: () => T): T { return signals.run(signal, action); }
export function cancelDownload(controller: AbortController): void { controller.abort(new Error(cancellationMessage)); }
