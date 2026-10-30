import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
vi.mock('./api/ipc', () => ({
  ipc: {
    listState: vi.fn().mockResolvedValue({ workspaces: [], builders: [], sessions: [] }),
    detectAgents: vi.fn().mockResolvedValue([]),
    onSessionUpdated: vi.fn().mockResolvedValue(() => {}),
    onSessionRemoved: vi.fn().mockResolvedValue(() => {}),
    onConfirmQuit: vi.fn().mockResolvedValue(() => {}),
  },
}));
vi.mock('./components/TerminalView', () => ({ default: () => null }));
import App from './App';
test('renders app title', async () => { render(<App />); expect(await screen.findByText('Clash of Claudes')).toBeTruthy(); });
