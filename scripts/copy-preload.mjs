import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/main/preload.cjs', import.meta.url), new URL('../dist/main/preload.cjs', import.meta.url));
