// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { LiveServer } from './LiveServer';
vi.mock('../api', () => ({ api: { packages: vi.fn(), toolRequest: vi.fn() } }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.mocked(api.packages).mockResolvedValue([
    {
      id: 'live-server',
      name: 'Live Server',
      description: '',
      version: '0.1.0',
      installed: true,
      enabled: true,
      running: false,
      capabilities: [],
    },
  ]);
  vi.mocked(api.toolRequest).mockResolvedValue({ running: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('starts during a background status check and ignores its older stopped result', async () => {
  render(<LiveServer onClose={() => {}} onPackages={() => {}} />);
  const start = await screen.findByRole('button', { name: 'Start server' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  vi.useFakeTimers();
  let finishStatus!: (value: { running: boolean }) => void;
  const pending = new Promise<{ running: boolean }>((resolve) => {
    finishStatus = resolve;
  });
  vi.mocked(api.toolRequest).mockImplementation(async (_id, method) => {
    if (method === 'status') return (await pending) as never;
    return { running: true, url: 'http://127.0.0.1:5500/' } as never;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  await act(async () => {
    fireEvent.click(start);
  });
  expect(screen.getByRole('button', { name: 'Stop server' })).toBeTruthy();
  await act(async () => {
    finishStatus({ running: false });
  });
  expect(screen.getByRole('button', { name: 'Stop server' })).toBeTruthy();
});

it('offers package installation without starting a worker when unavailable', async () => {
  vi.mocked(api.packages).mockResolvedValue([]);
  const manage = vi.fn();
  render(<LiveServer onClose={() => {}} onPackages={manage} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Manage packages' }));
  expect(manage).toHaveBeenCalled();
  expect(api.toolRequest).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Start server' })).toBeNull();
});

it('starts with the chosen folder and port, opens the browser, and stops', async () => {
  render(<LiveServer onClose={() => {}} onPackages={() => {}} />);
  const start = await screen.findByRole('button', { name: 'Start server' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'public' } });
  fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5501' } });
  vi.mocked(api.toolRequest).mockResolvedValue({
    running: true,
    directory: '/workspace/public',
    url: 'http://127.0.0.1:5501/',
  });
  fireEvent.click(start);
  await screen.findByRole('button', { name: 'Stop server' });
  expect(api.toolRequest).toHaveBeenCalledWith('live-server', 'start', {
    directory: 'public',
    port: 5501,
  });
  await waitFor(() => expect(api.toolRequest).toHaveBeenCalledWith('live-server', 'open'));
  vi.mocked(api.toolRequest).mockResolvedValue({ running: false });
  fireEvent.click(screen.getByRole('button', { name: 'Stop server' }));
  await screen.findByRole('button', { name: 'Start server' });
  expect(api.toolRequest).toHaveBeenCalledWith('live-server', 'stop');
});

it('keeps a running server visible when opening the browser fails, and closing leaves it running', async () => {
  const close = vi.fn();
  render(<LiveServer onClose={close} onPackages={() => {}} />);
  const start = await screen.findByRole('button', { name: 'Start server' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  vi.mocked(api.toolRequest).mockImplementation(async (_id, method) => {
    if (method === 'open') throw new Error('Browser could not open.');
    return { running: true, url: 'http://127.0.0.1:5500/' } as never;
  });
  fireEvent.click(start);
  expect((await screen.findByRole('alert')).textContent).toContain('Browser could not open');
  expect(screen.getByRole('button', { name: 'Stop server' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(close).toHaveBeenCalled();
  expect(api.toolRequest).not.toHaveBeenCalledWith('live-server', 'stop');
});

it('reports start errors and restores an already running server when reopened', async () => {
  const view = render(<LiveServer onClose={() => {}} onPackages={() => {}} />);
  const start = await screen.findByRole('button', { name: 'Start server' });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  vi.mocked(api.toolRequest).mockRejectedValueOnce(new Error('Port 5500 is already in use.'));
  fireEvent.click(start);
  expect((await screen.findByRole('alert')).textContent).toContain('already in use');
  view.unmount();
  vi.mocked(api.toolRequest).mockResolvedValue({
    running: true,
    directory: '/workspace/public',
    url: 'http://127.0.0.1:5500/',
  });
  render(<LiveServer onClose={() => {}} onPackages={() => {}} />);
  await screen.findByRole('button', { name: 'Stop server' });
  expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('/workspace/public');
});
