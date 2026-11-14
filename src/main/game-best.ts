import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const validScore = (score: unknown): score is number => Number.isSafeInteger(score) && typeof score === 'number' && score >= 0;

export function createGameBestStore(userData: string) {
  const path = join(userData, 'mini-game-best.json');
  function read(): number {
    if (!existsSync(path)) return 0;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!validScore(value)) throw new Error('Invalid mini-game record');
    return value;
  }
  function save(score: unknown): number {
    if (!validScore(score)) throw new Error('Invalid mini-game score');
    const current = read();
    if (score <= current) return current;
    const best = score;
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(best), 'utf8');
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    return best;
  }
  return { read, save };
}
