import { gunzipSync, gzipSync } from 'node:zlib';

export const defaultServerAddress = 'c4.play2go.cloud:20203';
const fail = () => new Error('Не удалось прочитать servers.dat. Список серверов оставлен без изменений.');

type Tag = { type: number; name: string; start: number; payload: number; end: number; children?: Tag[]; listType?: number; count?: number; text?: string };

function parse(bytes: Buffer) {
  let offset = 0;
  let tags = 0;
  const take = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw fail();
    const start = offset;
    offset += size;
    return start;
  };
  const byte = () => bytes[take(1)];
  const int = () => bytes.readInt32BE(take(4));
  const string = () => {
    const size = bytes.readUInt16BE(take(2));
    const start = take(size);
    return bytes.toString('utf8', start, start + size);
  };
  const tag = (depth: number, listType?: number): Tag => {
    if (depth > 32 || ++tags > 100_000) throw fail();
    const start = offset;
    const type = listType ?? byte();
    const name = listType === undefined && type !== 0 ? string() : '';
    const value: Tag = { type, name, start, payload: offset, end: offset };
    if (type >= 1 && type <= 6) take([0, 1, 2, 4, 8, 4, 8][type]);
    else if ([7, 11, 12].includes(type)) take(int() * (type === 7 ? 1 : type === 11 ? 4 : 8));
    else if (type === 8) value.text = string();
    else if (type === 9) {
      value.listType = byte();
      value.count = int();
      if (value.count < 0 || value.count > 100_000 || value.listType > 12 || (value.listType === 0 && value.count !== 0)) throw fail();
      value.children = Array.from({ length: value.count }, () => tag(depth + 1, value.listType));
    } else if (type === 10) {
      value.children = [];
      while (true) {
        const child = tag(depth + 1);
        if (child.type === 0) break;
        value.children.push(child);
      }
    } else if (type !== 0) throw fail();
    value.end = offset;
    return value;
  };
  const root = tag(0);
  if (root.type !== 10 || offset !== bytes.length) throw fail();
  return root;
}

const word = (value: string) => {
  const text = Buffer.from(value);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(text.length);
  return Buffer.concat([size, text]);
};
const integer = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const textTag = (name: string, value: string) => Buffer.concat([Buffer.from([8]), word(name), word(value)]);

export function addDefaultServer(previous: Buffer | null): Buffer {
  const compressed = previous?.[0] === 0x1f && previous?.[1] === 0x8b;
  let bytes: Buffer;
  try { bytes = previous ? compressed ? gunzipSync(previous, { maxOutputLength: 4_194_304 }) : previous : Buffer.from([10, 0, 0, 0]); }
  catch { throw fail(); }
  const root = parse(bytes);
  const lists = root.children!.filter(tag => tag.name === 'servers');
  if (lists.length > 1) throw fail();
  const list = lists[0];
  if (list && (list.type !== 9 || (list.listType !== 10 && !(list.listType === 0 && list.count === 0)))) throw fail();
  let found = false;
  for (const server of list?.children ?? []) {
    const ips = server.children!.filter(tag => tag.name === 'ip');
    if (ips.length !== 1 || ips[0].type !== 8) throw fail();
    if (ips[0].text?.trim().toLowerCase() === defaultServerAddress) found = true;
  }
  if (found) return previous!;
  const entry = Buffer.concat([textTag('name', 'KAYVEL'), textTag('ip', defaultServerAddress), Buffer.from([0])]);
  let next: Buffer;
  if (list) {
    next = Buffer.concat([bytes.subarray(0, list.payload), Buffer.from([10]), integer(list.count! + 1), bytes.subarray(list.payload + 5, list.end), entry, bytes.subarray(list.end)]);
  } else {
    next = Buffer.concat([bytes.subarray(0, root.end - 1), Buffer.from([9]), word('servers'), Buffer.from([10]), integer(1), entry, bytes.subarray(root.end - 1)]);
  }
  if (next.length > 4_194_304) throw fail();
  parse(next);
  return compressed ? gzipSync(next) : next;
}
