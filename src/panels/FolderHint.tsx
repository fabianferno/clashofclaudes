import { DEFAULT_PARENT_LABEL } from '../state/workspaceActions';

/** Under a new-folder name field: where the folder goes, and a link to put it elsewhere. */
export default function FolderHint({ disabled, onChoose }: { disabled: boolean; onChoose: () => void }) {
  return (
    <div className="sp-d folder-hint">
      Goes in {DEFAULT_PARENT_LABEL} ·{' '}
      <button type="button" className="sp-link" disabled={disabled} onClick={onChoose}>Choose location…</button>
    </div>
  );
}
