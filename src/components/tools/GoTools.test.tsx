// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuildContext } from '../../contracts';
import { GoTools } from './GoTools';
import { goTool } from './go-api';
vi.mock('./go-api', () => ({ goTool: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(goTool).mockImplementation(async (method) => ({
    state: 'complete',
    reasons: [],
    ...(method === 'debug.start' && { sessionId: 'fixture-session' }),
    ...(method === 'debug.request' && { response: { success: true, body: {} } }),
    ...(method === 'debug.poll' && { status: 'stopped', events: [], cursor: 0 }),
  }));
});
const context = (id: string, root: string, profileId?: string): BuildContext => ({
  id,
  root,
  configPath: `${root}/go.mod`,
  language: 'go',
  state: 'ready',
  ...(profileId && { profileId }),
});
const target = {
  path: '/fixture/api/cmd/server',
  workingDirectory: '/fixture/api',
  args: ['--port', '8080'],
  mode: 'debug' as const,
};
const props = () => ({
  contexts: [
    context('other', '/fixture/other'),
    context('root', '/fixture'),
    context('tagged', '/fixture/api', 'custom'),
    context('api', '/fixture/api'),
  ],
  path: '/fixture/other/main.go',
  configuredTarget: target,
  breakpoints: {},
  onCoverage: vi.fn(),
  onOpen: vi.fn(),
  onExecution: vi.fn(),
  onClose: vi.fn(),
  beforeStart: vi.fn(async () => {}),
});
it('prepares imported debugging without starting, then uses the nearest default context and exact arguments on explicit click', async () => {
  const input = props();
  render(<GoTools {...input} />);
  expect(goTool).not.toHaveBeenCalled();
  expect(screen.getByText(/Prepared Go debug target/).textContent).toContain(target.path);
  fireEvent.click(screen.getByRole('button', { name: 'Debug prepared configuration' }));
  await waitFor(() =>
    expect(goTool).toHaveBeenCalledWith('debug.request', {
      sessionId: 'fixture-session',
      command: 'launch',
      arguments: {
        mode: 'debug',
        program: target.path,
        cwd: target.workingDirectory,
        args: target.args,
        stopOnEntry: false,
      },
    }),
  );
  expect(input.beforeStart).toHaveBeenCalledOnce();
  expect(goTool).toHaveBeenCalledWith('debug.start', { contextId: 'api', path: target.path });
});
it('shows an explicit unavailable-context error instead of using an unrelated or tagged Go context', async () => {
  render(
    <GoTools
      {...props()}
      contexts={[context('other', '/elsewhere'), context('tagged', '/fixture/api', 'tagged')]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Debug prepared configuration' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringMatching(/Go package.*default.*context/i),
  );
  expect(goTool).not.toHaveBeenCalled();
});
it('does not start an obsolete prepared target when it changes while document flush is pending', async () => {
  let release!: () => void;
  const input = props();
  input.beforeStart = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<GoTools {...input} />);
  fireEvent.click(screen.getByRole('button', { name: 'Debug prepared configuration' }));
  view.rerender(<GoTools {...input} configuredTarget={{ ...target, path: '/fixture/other' }} />);
  release();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed.*again/i));
  expect(goTool).not.toHaveBeenCalled();
});
it('starts debugging at once when the toolbar Debug button sends a target', async () => {
  render(<GoTools {...props()} configuredTarget={{ ...target, start: 1 }} />);
  await waitFor(() =>
    expect(goTool).toHaveBeenCalledWith('debug.start', { contextId: 'api', path: target.path }),
  );
});
it('imports a run configuration’s Go target, working directory, arguments and environment', async () => {
  render(
    <GoTools
      {...props()}
      configuredTarget={undefined}
      root="/fixture"
      runConfigurations={[
        {
          id: 'server',
          name: 'Server',
          command: 'go run ./cmd/server',
          workingDirectory: 'api',
          env: [{ name: 'PORT', value: '9090' }],
          debug: {
            provider: 'go',
            mode: 'debug',
            path: 'api/cmd/server',
            workingDirectory: 'api',
            args: ['--verbose'],
          },
        },
      ]}
    />,
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Import run configuration' }), {
    target: { value: 'server' },
  });
  expect(screen.getByText(/Server: Go debug target/).textContent).toContain('PORT');
  fireEvent.click(screen.getByRole('button', { name: 'Debug prepared configuration' }));
  await waitFor(() =>
    expect(goTool).toHaveBeenCalledWith('debug.request', {
      sessionId: 'fixture-session',
      command: 'launch',
      arguments: expect.objectContaining({
        program: '/fixture/api/cmd/server',
        cwd: '/fixture/api',
        args: ['--verbose'],
        env: { PORT: '9090' },
      }),
    }),
  );
});
