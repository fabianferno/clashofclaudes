import type { SoundMoment } from '../api/types';

const system = (name: string) => `/System/Library/Sounds/${name}.aiff`;

/** What each moment plays on a fresh install (mirrors `sounds::default_sounds` in Rust); "" is silent. */
export const DEFAULT_SOUNDS: Record<SoundMoment, string> = {
  decide: system('Morse'),
  answer: system('Blow'),
  finished: system('Hero'),
  stuck: '',
  start: system('Glass'),
  minion: system('Pop'),
  working: '',
  xp: system('Bottle'),
  levelUp: system('Submarine'),
};
