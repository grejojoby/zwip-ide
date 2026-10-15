// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  expect(await screen.findByDisplayValue('SELECT 1;')).toBeTruthy();
  expect(queryConsoleApi.get).toHaveBeenCalledWith('ready');
});

it('writes the query console after edits and flushes on close', async () => {
  const view = render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  fireEvent.change(await screen.findByLabelText('SQL query'), {
    target: { value: 'SELECT 2;' },
  });
  view.unmount();
  await waitFor(() => expect(queryConsoleApi.save).toHaveBeenCalledWith('ready', 'SELECT 2;'));
});

it('renders only the code editor in the tab and keeps query controls in the results host', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={host}
      onShowResults={() => {}}
    />,
  );
  const query = await screen.findByLabelText('SQL query');
  expect(host.contains(query)).toBe(false);
  expect(host.contains(screen.getByRole('button', { name: 'Execute' }))).toBe(true);
  expect(view.container.querySelector('details.sql-query-box')).toBeNull();
  view.rerender(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible={false}
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  expect(query.closest('section')?.hidden).toBe(true);
  expect(queryConsoleApi.get).toHaveBeenCalledTimes(1);
  expect(toolRequest).not.toHaveBeenCalledWith('sql', 'disconnect', expect.anything());
  view.unmount();
  host.remove();
});
it('does not replace a saved console with an empty editable buffer when loading fails', async () => {
  vi.mocked(queryConsoleApi.get).mockRejectedValue(new Error('Cannot read console'));
  render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  expect((await screen.findByRole('alert')).textContent).toContain('Cannot read console');
  expect(screen.queryByLabelText('SQL query')).toBeNull();
  expect(queryConsoleApi.save).not.toHaveBeenCalled();
});

it('refreshes edited connection settings without replacing its SQL buffer', async () => {
  const view = render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  const editor = await screen.findByLabelText('SQL query');
  fireEvent.change(editor, { target: { value: 'SELECT saved_work;' } });
  view.rerender(
    <SqlBrowser
      connection={{
        ...connection,
        name: 'Renamed',
        config: { ...connection.config, host: 'database.example' },
      }}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
    />,
  );
  expect(screen.getByLabelText('SQL query')).toBe(editor);
  expect(queryConsoleApi.get).toHaveBeenCalledTimes(1);
  expect(toolRequest).toHaveBeenCalledTimes(2);
  view.unmount();
  await waitFor(() =>
    expect(queryConsoleApi.save).toHaveBeenCalledWith('ready', 'SELECT saved_work;'),
  );
});

it('serializes pending saves and retains the latest edit even when text returns to an earlier value', async () => {
  let completeFirst: (() => void) | undefined;
  vi.mocked(queryConsoleApi.save).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = () => resolve({ content: 'SELECT A;' });
      }),
  );
  const controller: { flush?: () => Promise<void> } = {};
  render(
    <SqlBrowser
      connection={connection}
      onDirty={() => {}}
      visible
      resultsTarget={null}
      onShowResults={() => {}}
      onRegisterClose={(_, flush) => {
        controller.flush = flush ?? undefined;
      }}
    />,
  );
  const editor = await screen.findByLabelText('SQL query');
  fireEvent.change(editor, { target: { value: 'SELECT A;' } });
  const first = controller.flush!();
  await waitFor(() => expect(queryConsoleApi.save).toHaveBeenCalledTimes(1));
  fireEvent.change(editor, { target: { value: 'SELECT B;' } });
  const second = controller.flush!();
  fireEvent.change(editor, { target: { value: 'SELECT A;' } });
  completeFirst!();
  await Promise.all([first, second]);
  expect(queryConsoleApi.save).toHaveBeenCalledWith('ready', 'SELECT B;');
  expect(queryConsoleApi.save).toHaveBeenLastCalledWith('ready', 'SELECT A;');
});
