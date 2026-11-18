import { availableJava21 } from './java-runtime.js';

export function requireAvailableJava21(root: string, find: (directory: string) => string | null = availableJava21): string {
  const java = find(root);
  if (!java) throw new Error('Java 21 не найдена. Автоматическая загрузка Java при запуске отключена; проверьте установленную Java вручную.');
  return java;
}
