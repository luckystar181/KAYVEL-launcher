import { useEffect, useRef, useState } from 'react';
import { SkinViewer } from 'skinview3d';
import { loadPreviewImage } from './skin-preview-helpers';

export function SkinPreview3D({ file, model, lang }: { file: File | null; model: 'classic' | 'slim'; lang: 'ru' | 'en' }) {
  const stage = useRef<HTMLDivElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!stage.current) return;
    try {
      const size = stage.current.getBoundingClientRect();
      const instance = new SkinViewer({ width: Math.max(1, size.width), height: Math.max(1, size.height), zoom: 0.82 });
      viewer.current = instance;
      stage.current.appendChild(instance.canvas);
      instance.controls.enablePan = false;
      const resize = new ResizeObserver(entries => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) instance.setSize(width, height);
      });
      resize.observe(stage.current);
      return () => {
        resize.disconnect();
        instance.dispose();
        instance.canvas.remove();
        viewer.current = null;
      };
    } catch { setError(true); }
  }, []);

  useEffect(() => {
    const instance = viewer.current;
    if (!instance) return;
    setError(false);
    instance.loadSkin(null);
    if (!file) return;
    return loadPreviewImage(file, source => createImageBitmap(source), image => {
      instance.loadSkin(image, { model: model === 'slim' ? 'slim' : 'default' });
    }, () => setError(true));
  }, [file, model]);

  return <div className="skin-stage skin-stage-3d" ref={stage} aria-label={lang === 'ru' ? 'Трёхмерный предпросмотр скина' : '3D skin preview'}>
    {!file && <span className="skin-stage-hint">{lang === 'ru' ? 'Выберите PNG-файл скина' : 'Choose a skin PNG file'}</span>}
    {error && <span className="skin-stage-error" role="alert">{lang === 'ru' ? 'Не удалось показать скин в 3D. Проверьте PNG и поддержку графики.' : 'Could not display 3D skin. Check the PNG and graphics support.'}</span>}
  </div>;
}
