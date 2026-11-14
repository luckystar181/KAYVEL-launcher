import { availableJava21 } from './java-runtime.js';

type IsolationPrompt = {
  type: 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
};

export async function confirmNetworkIsolation(show: (options: IsolationPrompt) => Promise<{ response: number }>, language: unknown): Promise<boolean> {
  const english = language === 'en';
  const result = await show({
    type: 'warning',
    title: english ? 'Network isolation' : 'Сетевая изоляция',
    message: english ? 'Have you separately confirmed network isolation for this launch?' : 'Вы отдельно подтвердили сетевую изоляцию для этого запуска?',
    detail: english ? 'The launcher does not verify or enforce isolation. Cancel if it has not been confirmed.' : 'Лаунчер не проверяет и не обеспечивает изоляцию. Если она не подтверждена, отмените запуск.',
    buttons: english ? ['Cancel', 'Isolation confirmed — launch'] : ['Отмена', 'Изоляция подтверждена — запустить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
}

export function requireAvailableJava21(root: string, find: (directory: string) => string | null = availableJava21): string {
  const java = find(root);
  if (!java) throw new Error('Java 21 не найдена. Автоматическая загрузка Java при запуске отключена; проверьте установленную Java вручную.');
  return java;
}
