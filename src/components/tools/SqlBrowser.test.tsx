// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqlBrowser } from './SqlBrowser';
import { queryConsoleApi, toolRequest } from './tool-api';

vi.mock('./tool-api', async () => {
  const actual = await vi.importActual<typeof import('./tool-api')>('./tool-api');
  return {
    ...actual,
    queryConsoleApi: { get: vi.fn(), save: vi.fn() },
    toolRequest: vi.fn(),
  };
});
vi.mock('./SqlConsole', () => ({
  SqlConsole: ({
    initialContent,
    onChange,
    onRead,
  }: {
    initialContent?: string;
    onChange?(content: string): void;
    onRead(read: () => string): void;
  }) => {
    onRead(() => initialContent ?? '');
    return (
      <textarea
        aria-label="SQL query"
        defaultValue={initialContent}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  },
}));

const connection = {
  id: 'ready',
  name: 'Demo PostgreSQL',
  kind: 'postgres' as const,
  config: { host: '127.0.0.1', port: 5432, database: 'demo' },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(toolRequest).mockResolvedValue([]);
  vi.mocked(queryConsoleApi.get).mockResolvedValue({ content: 'SELECT 1;' });
  vi.mocked(queryConsoleApi.save).mockResolvedValue({ content: 'SELECT 1;' });
});

it('loads the saved query console for the connection', async () => {
  render(<SqlBrowser connection={connection} onDirty={() => {}} />);
  expect(await screen.findByDisplayValue('SELECT 1;')).toBeTruthy();
  expect(queryConsoleApi.get).toHaveBeenCalledWith('ready');
});

it('writes the query console after edits and flushes on close', async () => {
  const view = render(<SqlBrowser connection={connection} onDirty={() => {}} />);
  fireEvent.change(await screen.findByLabelText('SQL query'), {
    target: { value: 'SELECT 2;' },
  });
  view.unmount();
  expect(queryConsoleApi.save).toHaveBeenCalledWith('ready', 'SELECT 2;');
});
