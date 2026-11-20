import React from 'react';
import type { LauncherUpdateStatus } from '../main/launcher-update-status';

type Props = { status: LauncherUpdateStatus | null; busy: boolean; lang: 'ru' | 'en'; onCheck: () => void; onUpdate: () => void };
export function LauncherUpdatePanel({ status, busy, lang, onCheck, onUpdate }: Props) {
  const ru = lang === 'ru';
  const labels: Record<LauncherUpdateStatus['state'], string> = ru ? {
    unchecked: 'Обновления лаунчера ещё не проверены', checking: 'Проверка лаунчера…', unavailable: 'Канал обновлений пока недоступен', current: 'Лаунчер актуален',
    available: 'Доступно обновление лаунчера', downloading: 'Загрузка установщика…', 'installer-open': 'Установщик открыт', error: 'Не удалось проверить или установить обновление лаунчера'
  } : {
    unchecked: 'Launcher updates not checked', checking: 'Checking launcher…', unavailable: 'Update channel is not available yet', current: 'Launcher is up to date',
    available: 'Launcher update available', downloading: 'Downloading installer…', 'installer-open': 'Installer opened', error: 'Could not check or install launcher update'
  };
  return <section className="modpack-update launcher-update" aria-label={ru ? 'Обновление лаунчера' : 'Launcher update'}>
    <div className="modpack-update-copy"><strong>{labels[status?.state ?? 'unchecked']}</strong><small>{status?.installedVersion}{status?.latestVersion && ` → ${status.latestVersion}`}</small>
      {status?.state === 'unavailable' && <small>{ru ? 'Метаданные обновлений не найдены. Актуальность версии не подтверждена; играть можно.' : 'Update metadata was not found. Version freshness is unconfirmed; you can still play.'}</small>}
      {status?.message && <small role="status">{status.message}</small>}
      {status?.state === 'available' && <small>{ru ? 'Установка — только с подтверждением. Старая версия и игровые данные сохраняются.' : 'Installation requires confirmation. The old version and game data are kept.'}</small>}
    </div><div className="modpack-update-actions"><button type="button" disabled={busy || status?.state === 'checking'} onClick={onCheck}>{ru ? 'Проверить лаунчер' : 'Check launcher'}</button>
      {status?.state === 'available' && <button type="button" disabled={busy} onClick={onUpdate}>{ru ? 'Обновить лаунчер' : 'Update launcher'}</button>}
    </div>
  </section>;
}
