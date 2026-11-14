export function supportedSkinHeadSize(width: number, height: number): boolean {
  return (width === 64 && (height === 32 || height === 64)) || (width === 128 && height === 128);
}

export function loadPreviewImage<T extends { close(): void }>(
  file: Blob,
  decode: (file: Blob) => Promise<T>,
  show: (image: T) => void,
  onError: () => void
): () => void {
  let active = true;
  void (async () => {
    try {
      const image = await decode(file);
      try { if (active) show(image); }
      finally { image.close(); }
    } catch {
      if (active) onError();
    }
  })();
  return () => { active = false; };
}
