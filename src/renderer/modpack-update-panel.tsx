import React from 'react';
import type { ModpackUpdateStatus } from '../main/modpack-update-status';

type Props = {
  status: ModpackUpdateStatus | null;
  busy: boolean;
  checking: boolean;
  lang: 'ru' | 'en';
  onCheck: () => void;
  onUpdate: () => void;
};

export function ModpackUpdatePanel({ status, busy, checking, lang, onCheck, onUpdate }: Props) {
  const ru = lang === 'ru';
  const state = status?.state ?? 'unchecked';
  const labels: Record<ModpackUpdateStatus['state'], string> = ru ? {
    unchecked: 'Обновления ещё не проверены', checking: 'Проверка обновлений…', current: 'Установлена актуальная сборка',
    available: 'Доступно обновление сборки', error: 'Не удалось проверить или применить обновление', updating: 'Обновление сборки…',
    'not-installed': 'Сборка доступна для первой установки'
  } : {
    unchecked: 'Updates have not been checked', checking: 'Checking for updates…', current: 'Modpack is up to date',
    available: 'A modpack update is available', error: 'Could not check or apply the update', updating: 'Updating modpack…',
    'not-installed': 'Modpack is available for first installation'
  };
  return <section className="modpack-update" aria-label={ru ? 'Обновления сборки' : 'Modpack updates'}>
    <div className="modpack-update-copy" role="status">
      <strong>{labels[state]}</strong>
      <small>{ru ? 'Установлено' : 'Installed'}: {status?.installedVersion ?? '—'} · {ru ? 'Доступно' : 'Latest'}: {status?.latestVersion ?? '—'}</small>
      {status?.message && <small>{status.message}</small>}
      {state === 'available' && <small>{ru ? 'Миры и личные файлы не заменяются. Изменяемые файлы сборки сохраняются в резервную копию. Игра не запустится автоматически.' : 'Worlds and personal files are not replaced. Changed managed files are backed up. The game will not start automatically.'}</small>}
    </div>
    <div className="modpack-update-actions">
      <button type="button" disabled={busy || checking || state === 'checking' || state === 'updating'} onClick={onCheck}>{ru ? 'Проверить обновления' : 'Check for updates'}</button>
      {state === 'available' && <button type="button" className="update-button" disabled={busy || checking} onClick={onUpdate}>{ru ? 'Обновить' : 'Update'}</button>}
    </div>
  </section>;
}
