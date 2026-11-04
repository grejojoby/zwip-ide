// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RunConfigurationSelector } from './RunConfigurationSelector';

afterEach(cleanup);
const configurations = [
  { id: 'api', name: 'API server', command: 'go run .', workingDirectory: 'services/api' },
  { id: 'web', name: 'Web app', command: 'npm run dev', workingDirectory: '.' },
];
function setup(selectedId: string | null = 'api', disabled = false) {
  const onSelect = vi.fn();
  const onManage = vi.fn();
  const view = render(
    <>
      <RunConfigurationSelector
        configurations={configurations}
        selectedId={selectedId}
        disabled={disabled}
        onSelect={onSelect}
        onManage={onManage}
      />
      <button>Run</button>
    </>,
  );
  return {
    ...view,
    onSelect,
    onManage,
    trigger: screen.getByRole('button', { name: 'Run configuration' }),
  };
}

it('shows the selected configuration and directory, then selects without executing it', async () => {
  const user = userEvent.setup();
  const { trigger, onSelect, onManage } = setup();
  expect(trigger.textContent).toContain('API server');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await user.click(trigger);
  const selected = screen.getByRole('menuitemradio', { name: 'API server', checked: true });
  expect(document.activeElement).toBe(selected);
  expect(screen.getByText('services/api')).toBeTruthy();
  await user.click(screen.getByRole('menuitemradio', { name: 'Web app' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('web');
  expect(onManage).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('supports arrows, Home, End, typeahead, Enter, and Escape', async () => {
  const user = userEvent.setup();
  const { trigger, onSelect } = setup();
  trigger.focus();
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('web');
  await user.keyboard('{ArrowUp}{Home}');
  expect(document.activeElement).toBe(
    screen.getByRole('menuitemradio', { name: 'Workspace command…' }),
  );
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Edit configurations…' }),
  );
  await user.keyboard('a');
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'API server' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it('dismisses on outside click and Tab without trapping keyboard focus', async () => {
  const user = userEvent.setup();
  const { trigger } = setup();
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Run' }));
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  await user.tab();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run' }));
});

it('clears the selection for a workspace command and opens the configuration editor separately', async () => {
  const user = userEvent.setup();
  const { trigger, onSelect, onManage } = setup();
  await user.click(trigger);
  await user.click(screen.getByRole('menuitemradio', { name: 'Workspace command…' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  await user.click(trigger);
  await user.click(screen.getByRole('menuitem', { name: 'Edit configurations…' }));
  expect(onManage).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('makes the empty state useful and prevents opening while disabled', async () => {
  const user = userEvent.setup();
  const onManage = vi.fn();
  const props = { configurations: [], selectedId: null, onSelect: vi.fn(), onManage };
  const { rerender } = render(<RunConfigurationSelector {...props} />);
  const trigger = screen.getByRole('button', { name: 'Run configuration' });
  expect(trigger.textContent).toContain('Workspace command…');
  await user.click(trigger);
  expect(screen.getByText('No saved configurations yet.')).toBeTruthy();
  await user.click(screen.getByRole('menuitem', { name: 'Edit configurations…' }));
  expect(onManage).toHaveBeenCalledOnce();
  rerender(<RunConfigurationSelector {...props} disabled />);
  fireEvent.click(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
});
