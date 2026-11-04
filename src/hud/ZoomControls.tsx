import { useApp } from '../state/store';
import { PANEL_W } from '../village/camera';

interface Props {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

/** A magnifying glass, white with the HUD's dark outline (like the Settings gear), with + or −. */
function Magnifier({ plus = false }: { plus?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d="M14.6 14.6 L20.5 20.5" stroke="#2b2018" strokeWidth="5.2" strokeLinecap="round" />
      <path d="M14.6 14.6 L20.5 20.5" stroke="#8a5a2b" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="10" cy="10" r="7" fill="#fff" stroke="#2b2018" strokeWidth="1.8" />
      <path d={plus ? 'M6.6 10h6.8M10 6.6v6.8' : 'M6.6 10h6.8'} stroke="#2b2018" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Zoom buttons at the right edge, vertically centred; they slide left when the panel is open. */
export default function ZoomControls({ onZoomIn, onZoomOut, onFit }: Props) {
  const panelOpen = useApp((s) => s.panelOpen);
  return (
    <div className="zoom-controls" style={{ right: panelOpen ? PANEL_W + 12 : 12 }} data-testid="zoom-controls">
      <button className="zoom-ico" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}><Magnifier plus /></button>
      <button className="zoom-ico" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}><Magnifier /></button>
      <button aria-label="Fit village" title="Fit village" onClick={onFit}>Village</button>
    </div>
  );
}
