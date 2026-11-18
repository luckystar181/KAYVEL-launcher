import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

export type MemorySettings = { memoryMb: number; minMemoryMb: number; maxMemoryMb: number; totalMemoryMb: number };

export function validateMemoryMb(value: unknown, maximum = 32768): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2048 || value > maximum || value % 512 !== 0) {
    throw new Error('Выберите объём ОЗУ от 2 ГБ до доступного предела с шагом 512 МБ.');
  }
  return value;
}

export function memoryLaunchOptions(memoryMb: number) {
  return { minMemory: 1024, maxMemory: validateMemoryMb(memoryMb) };
}

export function createMemorySettingsStore(userData: string, physicalBytes = totalmem()) {
  const path = join(userData, 'game-memory.json');
  const totalMemoryMb = Math.floor(physicalBytes / 1_048_576);
  const maxMemoryMb = Math.max(2048, Math.min(32768, Math.floor((totalMemoryMb - 2048) / 512) * 512));
  function existing() {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Файл настройки ОЗУ недоступен или является ссылкой.');
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  function view(memoryMb: number): MemorySettings {
    return { memoryMb: Math.min(memoryMb, maxMemoryMb), minMemoryMb: 2048, maxMemoryMb, totalMemoryMb };
  }
  function read(): MemorySettings {
    if (!existing()) return view(6144);
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('memoryMb' in data)) {
      throw new Error('Некорректный файл настройки ОЗУ: game-memory.json.');
    }
    return view(validateMemoryMb(data.memoryMb));
  }
  function save(value: unknown): MemorySettings {
    const memoryMb = validateMemoryMb(value, maxMemoryMb);
    existing();
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, memoryMb }), { flag: 'wx', mode: 0o600 });
    try {
      existing();
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return view(memoryMb);
  }
  return { read, save };
}
