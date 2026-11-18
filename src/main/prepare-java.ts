import { join } from 'node:path';
import { availableJava21, validJava21 } from './java-runtime.js';
import { readZipFiles } from './install-files.js';
import { PreparationFiles } from './preparation-files.js';
import { stageProgress, type ReportProgress } from './preparation-progress.js';
import { releaseDownloadUrl } from './release-download.js';

export const PREPARED_JAVA = 'runtime/jdk-21.0.13+9-jre/bin/java.exe';

export async function prepareJava(files: PreparationFiles, userData: string, report: ReportProgress): Promise<string> {
  stageProgress(report, 'java', 'Поиск Java 21');
  const existing = availableJava21(userData);
  if (existing) return existing;
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Автоматическая установка Java доступна только для Windows x64.');
  await files.downloads([{
    path: '.preparation/java.zip',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip',
    size: 49106397, hash: '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628', algorithm: 'sha256'
  }], 'java', report, releaseDownloadUrl);
  stageProgress(report, 'java', 'Распаковка Java 21');
  const entries = await readZipFiles(files.path('.preparation/java.zip'), () => true, 300_000_000);
  if (!entries.has('jdk-21.0.13+9-jre/bin/java.exe') || [...entries.keys()].some(name => !name.startsWith('jdk-21.0.13+9-jre/'))) throw new Error('Неожиданная структура архива Java.');
  for (const [name, bytes] of entries) await files.write('runtime/' + name, bytes);
  const java = join(files.root, PREPARED_JAVA);
  if (!validJava21(java)) throw new Error('Скачанная Java 21 не прошла проверку запуска.');
  return java;
}
