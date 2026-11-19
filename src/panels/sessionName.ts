import type { SessionInfo } from '../api/types';
import { plainText } from './markdownText';

/**
 * What a session is called on cards and headers: the agent's short name for it (the title it
 * gives its terminal, as a terminal tab shows), else the task as written (its markdown as plain text).
 */
export const sessionName = (s: Pick<SessionInfo, 'title' | 'task'>): string | null =>
  s.title?.trim() || (s.task ? plainText(s.task) || s.task : s.task);

/** The full task, as a tooltip, where the name shown is not the task itself. */
export const taskTooltip = (s: Pick<SessionInfo, 'title' | 'task'>): string | undefined => (s.task ? plainText(s.task) : undefined) || undefined;
