/** Longest name kept (the backend caps it too): it has to fit on the Town Hall's plate. */
export const PLAYER_NAME_MAX = 24;

/** A name as it is saved: trimmed, capped at PLAYER_NAME_MAX code points (as the backend counts), null when blank. */
export function cleanName(name: string | null | undefined): string | null {
  const n = Array.from((name ?? '').trim()).slice(0, PLAYER_NAME_MAX).join('').trim();
  return n || null;
}

/** "Fabian's Town Hall"; plain "Town Hall" before a name is given. */
export function townHallTitle(name: string | null | undefined): string {
  const n = cleanName(name);
  return n ? `${n}'s Town Hall` : 'Town Hall';
}
