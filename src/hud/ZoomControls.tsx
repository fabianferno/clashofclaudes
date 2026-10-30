import { useApp } from '../state/store';
import { PANEL_W } from '../village/camera';

interface Props {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

/** Zoom buttons at the right edge, vertically centred; they slide left when the panel is open. */
export default function ZoomControls({ onZoomIn, onZoomOut, onFit }: Props) {
  const panelOpen = useApp((s) => s.panelOpen);
  return (
    <div className="zoom-controls" style={{ right: panelOpen ? PANEL_W + 12 : 12 }} data-testid="zoom-controls">
      <button aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>+</button>
      <button aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>{'−'}</button>
      <button aria-label="Fit village" title="Fit village" onClick={onFit}>Village</button>
    </div>
  );
}
