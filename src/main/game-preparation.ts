export const PREPARATION_BLOCKED_MESSAGE = 'Подготовка Minecraft и NeoForge временно отключена: загрузчики ещё не гарантируют сохранность существующих файлов и отсутствие повторов. Уже установленные файлы можно запускать после отдельного подтверждения сетевой изоляции.';

export function assertGamePreparationAllowed(): void {
  throw new Error(PREPARATION_BLOCKED_MESSAGE);
}

export function gamePreparationUnavailable() {
  return { ok: false, message: PREPARATION_BLOCKED_MESSAGE };
}
