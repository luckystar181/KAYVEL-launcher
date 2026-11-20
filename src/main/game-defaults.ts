import { join } from 'node:path';
import { gameDataWriter, readGameData } from './game-data.js';
import { addDefaultServer } from './default-server.js';

const bindings: Record<string, string> = {
  'key_key.sable_player_ragdoll.ragdoll': 'key.keyboard.x',
  'key_key.freecam.toggle': 'key.keyboard.c'
};
const conflictingDefaults = [
  'key_key.createbigcannons.pitch_mode',
  'key_key.droneworks.commander_freelook',
  'key_key.easy_villagers.cycle_trades',
  'key_key.let_it_walk.raise',
  'key_powergrid.keyinfo.switch_layer',
  'key_tfmg.keyinfo.transmission_shift_down'
];

export function defaultKeyBindings(previous: Buffer | null): Buffer {
  const text = previous?.toString('utf8') ?? '';
  if (previous && (!Buffer.from(text).equals(previous) || text.includes('\0'))) throw new Error('Не удалось прочитать options.txt. Настройки сохранены без изменений.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set<string>();
  const next = text.replace(/[^\r\n]+/g, line => {
    const colon = line.indexOf(':');
    if (colon < 0) return line;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    seen.add(name);
    if (Object.hasOwn(bindings, name)) return `${name}:${bindings[name]}`;
    if (name.startsWith('key_') && /^key\.keyboard\.(x|c)(?::|$)/.test(value)) return `${name}:key.keyboard.unknown`;
    return line;
  });
  const extra = [
    ...Object.entries(bindings).filter(([name]) => !seen.has(name)).map(([name, value]) => `${name}:${value}`),
    ...conflictingDefaults.filter(name => !seen.has(name)).map(name => `${name}:key.keyboard.unknown`)
  ];
  return Buffer.from(next + (extra.length ? (next && !/[\r\n]$/.test(next) ? eol : '') + extra.join(eol) + eol : ''));
}

// Apply each default once so later changes in Minecraft remain the player's choice.
export function applyGameDefaults(gamePath: string): void {
  const writer = gameDataWriter(gamePath);
  const keysDone = writer.completed('keys-x-c');
  const serverDone = writer.completed('server-play2go');
  const options = keysDone ? null : readGameData(join(gamePath, 'options.txt'));
  const servers = serverDone ? null : readGameData(join(gamePath, 'servers.dat'));
  const nextOptions = keysDone ? null : defaultKeyBindings(options);
  const nextServers = serverDone ? null : addDefaultServer(servers);
  if (nextOptions) {
    writer.replace('options.txt', options, nextOptions);
    writer.complete('keys-x-c');
  }
  if (nextServers) {
    writer.replace('servers.dat', servers, nextServers);
    writer.complete('server-play2go');
  }
}
