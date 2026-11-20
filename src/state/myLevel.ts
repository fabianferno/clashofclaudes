import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { Level, VillageMap } from '../api/types';

/**
 * This Mac's level in a visited village: what the owner's map says for this Mac's key, Visitor
 * when the village has not paired it. It only decides which buttons are offered; the owner's
 * Mac checks every action against its own list.
 */
export function useMyLevel(map: VillageMap | undefined): Level {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    ipc.mateKey().then((k) => { if (live) setKey(k); }, () => {});
    return () => { live = false; };
  }, [map?.owner, map?.mates?.length]);
  return map?.mates?.find((m) => m.key === key)?.level ?? 'visitor';
}

export const LEVEL_WORDS: Record<Level, string> = { visitor: 'a Visitor', helper: 'a Helper', trusted: 'Trusted' };
