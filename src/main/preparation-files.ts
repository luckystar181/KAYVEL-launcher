import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadNewFile, fileDigest, type DownloadFile } from './official-download.js';
import { prepareFileDirectory, safeRelativePath, writeNewFile } from './install-files.js';
import { type PreparationStage, type ReportProgress } from './preparation-progress.js';

export type FileReceipt = { path: string; size: number; sha256: string };
export type PlannedDownload = Omit<DownloadFile, 'path'> & { path: string };

export class PreparationFiles {
  readonly receipts = new Map<string, FileReceipt>();
  constructor(readonly root: string) {}

  path(relative: string): string { return join(this.root, safeRelativePath(relative)); }

  async record(relative: string): Promise<void> {
    const path = this.path(relative);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Небезопасный подготовленный файл: ' + relative);
    const key = relative.toLowerCase();
    if (this.receipts.has(key)) throw new Error('Повторный подготовленный файл: ' + relative);
    this.receipts.set(key, { path: relative, size: info.size, sha256: await fileDigest(path) });
  }

  async write(relative: string, bytes: Uint8Array | string): Promise<void> {
    await writeNewFile(this.root, relative, bytes);
    await this.record(relative);
  }

  async downloads(plan: PlannedDownload[], stage: PreparationStage, report: ReportProgress,
      validateUrl?: (value: string) => string): Promise<void> {
    const unique = new Map<string, PlannedDownload>();
    for (const file of plan) {
      const key = safeRelativePath(file.path).toLowerCase();
      const old = unique.get(key);
      if (old && (old.hash !== file.hash || old.size !== file.size || old.algorithm !== file.algorithm)) throw new Error('Конфликт установочных файлов: ' + file.path);
      unique.set(key, file);
    }
    const queue: PlannedDownload[] = [];
    for (const [key, file] of unique) {
      const existing = this.receipts.get(key);
      if (existing) {
        if (existing.size !== file.size || await fileDigest(this.path(existing.path), file.algorithm) !== file.hash) throw new Error('Конфликт уже подготовленного файла: ' + file.path);
      } else queue.push(file);
    }
    const total = queue.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(total) || total > 4_000_000_000 || queue.length > 20_000) throw new Error('Слишком большой объём установки.');
    let next = 0;
    let received = 0;
    let completedFiles = 0;
    let failure: unknown;
    const results = await Promise.allSettled(Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (!failure && next < queue.length) {
        const file = queue[next++];
        let previous = 0;
        try {
          await prepareFileDirectory(this.root, file.path);
          await downloadNewFile({ ...file, path: this.path(file.path) }, current => {
            received += current - previous;
            previous = current;
            report({ stage, file: file.path, received, total, completedFiles, totalFiles: queue.length });
          }, validateUrl);
          await this.record(file.path);
          completedFiles++;
          report({ stage, file: file.path, received, total, completedFiles, totalFiles: queue.length });
        } catch (error) { failure ??= error; throw error; }
      }
    }));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
}
