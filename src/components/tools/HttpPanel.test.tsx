// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpPanel } from './HttpPanel';
import { toolRequest } from './tool-api';
vi.mock('./tool-api', () => ({ toolRequest: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe('HTTP panel request lifecycle', () => {
  it('does not count environment declarations as a request section', async () => {
    vi.mocked(toolRequest).mockImplementation(() => new Promise(() => {}));
    render(
      <HttpPanel
        source={
          '@base = https://example.test\n### one\nGET {{base}}/one\n### two\nGET {{base}}/two'
        }
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(toolRequest).toHaveBeenCalledWith(
        'http',
        'execute',
        expect.objectContaining({ requestIndex: 1 }),
      ),
    );
  });
  it('rejects invalid environment values before making a request', async () => {
    render(<HttpPanel source="GET http://localhost/test" />);
    fireEvent.change(screen.getByLabelText('HTTP environment variables'), {
      target: { value: '{"token":1}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Environment must be a JSON object containing string values.',
    );
    expect(toolRequest).not.toHaveBeenCalled();
  });
  it('cancels the owned request on close', async () => {
    vi.mocked(toolRequest).mockImplementation(() => new Promise(() => {}));
    const view = render(<HttpPanel source="GET http://localhost/test" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(toolRequest).toHaveBeenCalledWith(
        'http',
        'execute',
        expect.objectContaining({ source: 'GET http://localhost/test' }),
      ),
    );
    const params = vi.mocked(toolRequest).mock.calls[0][2];
    view.unmount();
    expect(toolRequest).toHaveBeenLastCalledWith('http', 'cancel', { id: params?.id });
  });
  it('renders response HTML as inert text', async () => {
    vi.mocked(toolRequest).mockResolvedValue({
      id: '1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '<script>alert(1)</script>',
      encoding: 'text',
      bytes: 25,
      durationMs: 2,
      url: '',
      truncated: false,
    });
    render(<HttpPanel source="GET http://localhost/test" />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBe(null);
  });
});
