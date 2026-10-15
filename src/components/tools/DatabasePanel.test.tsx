// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabasePanel } from './DatabasePanel';
import { api } from '../../api';
import { connectionApi, SELECTED_CONNECTION_KEY } from './tool-api';

vi.mock('../../api', () => ({
  api: {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
  },
}));
vi.mock('./tool-api', async () => {
  const actual = await vi.importActual<typeof import('./tool-api')>('./tool-api');
  return {
    ...actual,
    connectionApi: {
      list: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    },
    toolRequest: vi.fn(),
  };
});
vi.mock('./SqlBrowser', () => ({
  SqlBrowser: () => <div>SQL browser</div>,
}));
vi.mock('./RedisBrowser', () => ({
  RedisBrowser: () => <div>Redis browser</div>,
}));

const postgres = {
  id: 'ready',
  name: 'Demo PostgreSQL',
  kind: 'postgres' as const,
  config: { host: '127.0.0.1', port: 5432, database: 'demo' },
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(connectionApi.list).mockResolvedValue([postgres]);
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.setSetting).mockResolvedValue(null);
});

it('restores the last selected connection across panel mounts', async () => {
  vi.mocked(api.getSetting).mockResolvedValue('ready');
  render(
    <DatabasePanel
      dirty={false}
      onOpenConsole={() => {}}
      onRemoveConsole={async () => true}
      onResultsHost={() => {}}
      requestedConnection={null}
    />,
  );
  await waitFor(() =>
    expect((screen.getByLabelText('Saved database connection') as HTMLSelectElement).value).toBe(
      'ready',
    ),
  );
  expect(api.getSetting).toHaveBeenCalledWith(SELECTED_CONNECTION_KEY);
  expect(api.setSetting).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open SQL console' })).toBeTruthy();
});

it('stores the selected connection when the user changes it', async () => {
  render(
    <DatabasePanel
      dirty={false}
      onOpenConsole={() => {}}
      onRemoveConsole={async () => true}
      onResultsHost={() => {}}
      requestedConnection={null}
    />,
  );
  const select = await screen.findByLabelText('Saved database connection');
  fireEvent.change(select, { target: { value: 'ready' } });
  await waitFor(() =>
    expect(api.setSetting).toHaveBeenCalledWith(SELECTED_CONNECTION_KEY, 'ready'),
  );
});
