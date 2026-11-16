import { useEffect, useRef, useState } from 'react';

/** Resize the containing panel, keeping the drag above embedded desktops. */
export function ResizeHandle({ side, storageKey, initial, min, max, label }: {
  side: 'left' | 'right'; storageKey: string; initial: number; min: number; max: number; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem(storageKey)); return saved ? Math.min(max, Math.max(min, saved)) : initial; }
    catch { return initial; }
  });
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    ref.current?.parentElement?.style.setProperty('--panel-width', `${width}px`);
    try { localStorage.setItem(storageKey, String(width)); } catch { /* storage may be unavailable */ }
  }, [width, storageKey]);
  useEffect(() => () => { document.body.classList.remove('resizing-panels'); }, []);
  const change = (value: number) => setWidth(Math.max(min, Math.min(max, value)));
  const stop = () => { drag.current = null; document.body.classList.remove('resizing-panels'); };
  return <div ref={ref} className={`resize-handle resize-${side}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)}
    title="Drag to resize. Double-click to reset."
    onPointerDown={e => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag.current = { x: e.clientX, width: ref.current!.parentElement!.getBoundingClientRect().width };
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-panels');
    }}
    onPointerMove={e => { if (drag.current) change(drag.current.width + (e.clientX - drag.current.x) * (side === 'right' ? 1 : -1)); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
    onDoubleClick={() => change(initial)}
    onKeyDown={e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); change(width + (e.key === 'ArrowRight' ? 20 : -20) * (side === 'right' ? 1 : -1)); }
      if (e.key === 'Home') { e.preventDefault(); change(min); }
      if (e.key === 'End') { e.preventDefault(); change(max); }
    }} />;
}
