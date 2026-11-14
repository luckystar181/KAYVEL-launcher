export function sameKnownFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.ino !== 0n && b.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}
