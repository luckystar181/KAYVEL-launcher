import { join } from 'node:path';
import { availableJava21, validJava21 } from './java-runtime.js';
import { readZipFiles } from './install-files.js';
import { PreparationFiles } from './preparation-files.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { BUNDLED_JAVA_ROOT, readBundledJava } from './bundled-java.js';
import { checkDownloadCancelled } from './download-session.js';

export const PREPARED_JAVA = 'runtime/jdk-21.0.13+9-jre/bin/java.exe';

export async function prepareJava(files: PreparationFiles, userData: string, report: ReportProgress): Promise<string> {
  checkDownloadCancelled();
  stageProgress(report, 'java', 'Поиск Java 21');
  const existing = availableJava21(userData);
  if (existing) return existing;
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Автоматическая установка Java доступна только для Windows x64.');
  stageProgress(report, 'java', 'Проверка встроенного архива Java 21');
  await files.write('.preparation/java.zip', await readBundledJava());
  stageProgress(report, 'java', 'Распаковка Java 21');
  const entries = await readZipFiles(files.path('.preparation/java.zip'), () => true, 300_000_000);
  checkDownloadCancelled();
  if (!entries.has(`${BUNDLED_JAVA_ROOT}/bin/java.exe`) || !entries.has(`${BUNDLED_JAVA_ROOT}/legal/java.base/LICENSE`) || [...entries.keys()].some(name => !name.startsWith(BUNDLED_JAVA_ROOT + '/'))) throw new Error('Неожиданная структура архива Java.');
  for (const [name, bytes] of entries) await files.write('runtime/' + name, bytes);
  const java = join(files.root, PREPARED_JAVA);
  if (!validJava21(java)) throw new Error('Встроенная Java 21 не прошла проверку запуска.');
  return java;
}
