import React from 'react';
import type { PreparationProgress } from '../main/preparation-progress';

const labels = {
  ru: { java: 'Java 21', minecraft: 'Minecraft 1.21.1', neoforge: 'NeoForge 21.1.252', modpack: 'Подписанная сборка', verify: 'Проверка файлов', ready: 'Готово', launch: 'Запуск игры', error: 'Операция остановлена' },
  en: { java: 'Java 21', minecraft: 'Minecraft 1.21.1', neoforge: 'NeoForge 21.1.252', modpack: 'Signed modpack', verify: 'Verifying files', ready: 'Ready', launch: 'Launching game', error: 'Operation stopped' }
};

function bytes(value: number): string {
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

export function PreparationMeter({ progress, lang }: { progress: PreparationProgress; lang: 'ru' | 'en' }) {
  const measured = progress.total !== null && progress.total > 0;
  return <section className="preparation-meter" aria-label={lang === 'ru' ? 'Подготовка игры' : 'Game preparation'}>
    <div className="preparation-heading"><strong>{labels[lang][progress.stage]}</strong>{measured && <span>{Math.floor(progress.received / progress.total! * 100)}%</span>}</div>
    <progress className="sr-only" aria-label={labels[lang][progress.stage]} max={measured ? progress.total! : undefined} value={measured ? progress.received : undefined} />
    <div className={`preparation-track ${measured ? 'measured' : 'indeterminate'}`} aria-hidden="true"><span style={measured ? { transform: `scaleX(${Math.max(0, Math.min(1, progress.received / progress.total!))})` } : undefined} /></div>
    <small>{measured ? `${bytes(progress.received)} / ${bytes(progress.total!)}` : (lang === 'ru' ? 'Общий объём пока неизвестен' : 'Total size is not yet known')}{progress.totalFiles !== null && ` · ${progress.completedFiles} / ${progress.totalFiles} ${lang === 'ru' ? 'файлов' : 'files'}`}</small>
    <small className="preparation-file" title={progress.file}>{progress.file}</small>
  </section>;
}
