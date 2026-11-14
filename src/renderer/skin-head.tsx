import { useEffect, useRef } from 'react';
import { supportedSkinHeadSize } from './skin-preview-helpers';

export function SkinHead({ file, label }: { file: File | null; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    target.getContext('2d')?.clearRect(0, 0, 32, 32);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    let active = true;
    image.onload = () => {
      if (!active || !canvas.current || !supportedSkinHeadSize(image.width, image.height)) return;
      const scale = image.width / 64;
      const context = canvas.current.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, 32, 32);
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 32, 32);
      context.drawImage(image, 40 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 32, 32);
    };
    image.src = url;
    return () => { active = false; image.src = ''; URL.revokeObjectURL(url); };
  }, [file]);
  return <canvas ref={canvas} width={32} height={32} className={`skin-head ${file ? '' : 'skin-head-empty'}`} role="img" aria-label={label} />;
}
