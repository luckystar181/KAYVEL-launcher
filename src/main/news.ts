import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type NewsItem = { id: string; date: string; title: string; text: string };

const sample: NewsItem[] = [
  { id: 'welcome', date: '2026-11-01', title: 'Добро пожаловать в KAYVEL', text: 'Это пример локальной новости. Замените её своим объявлением.' },
  { id: 'editing', date: '2026-10-31', title: 'Как добавить новость', text: 'Откройте news.json в папке данных лаунчера, добавьте запись с уникальным id, датой, заголовком и текстом. Снова откройте вкладку «Новости».' }
];

function validate(value: unknown): NewsItem[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Invalid news');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid news');
    const { id, date, title, text } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 80 || !id || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof title !== 'string' || !title || title.length > 160 || typeof text !== 'string' || text.length > 4000) throw new Error('Invalid news');
    return { id, date, title, text };
  });
}

export function createNewsStore(userData: string) {
  const path = join(userData, 'news.json');
  return {
    path,
    async read(): Promise<NewsItem[]> {
      let content: string;
      try { content = await readFile(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(userData, { recursive: true });
        content = JSON.stringify(sample, null, 2);
        try { await writeFile(path, content, { flag: 'wx' }); }
        catch (writeError) {
          if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
          content = await readFile(path, 'utf8');
        }
      }
      if (content.length > 250_000) throw new Error('News file is too large');
      return validate(JSON.parse(content)).sort((a, b) => b.date.localeCompare(a.date));
    }
  };
}
