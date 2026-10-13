const screenshots = {
  push: {
    source: './images/git-push.png',
    alt: 'Push overview showing the destination, outgoing commit, changed file and inspectable diff in Zwip, captured before the rebrand.',
    caption:
      'Inspect the destination, outgoing commits and diffs before pushing. The plan is checked again before it runs.',
  },
  merge: {
    source: './images/git-merge.png',
    alt: 'Pre-rebrand capture of Zwip’s three-pane merge editor with current, editable result and incoming panes, plus a base comparison.',
    caption:
      'Compare current, result and incoming changes, with the common ancestor available below. Review the result before applying it.',
  },
  changes: {
    source: './images/git-changes.png',
    alt: 'Pre-rebrand capture of Zwip’s light theme with a changelist and changed files in the resizable right Git sidebar.',
    caption:
      'Keep changes and their diff alongside your editor. Review the selected file without leaving the workspace.',
  },
} as const;

const gitImage = document.querySelector<HTMLImageElement>('#git-image');
const gitImageLink = document.querySelector<HTMLAnchorElement>('#git-image-link');
const gitCaption = document.querySelector<HTMLElement>('#git-caption');
const viewButtons = document.querySelectorAll<HTMLButtonElement>('[data-view]');

const galleryControls = document.querySelector<HTMLElement>('.gallery-controls');
if (galleryControls) galleryControls.hidden = false;

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    const view = button.dataset.view;
    if (!view || !(view in screenshots) || !gitImage || !gitImageLink || !gitCaption) return;
    const screenshot = screenshots[view as keyof typeof screenshots];
    gitImage.src = screenshot.source;
    gitImage.alt = screenshot.alt;
    gitImageLink.href = screenshot.source;
    gitCaption.textContent = screenshot.caption;
    for (const control of viewButtons) {
      control.setAttribute('aria-pressed', String(control === button));
    }
  });
}

const copyButton = document.querySelector<HTMLButtonElement>('#copy-setup');
const setupCode = document.querySelector<HTMLElement>('#setup-code');
const copyStatus = document.querySelector<HTMLElement>('#copy-status');

if (copyButton && setupCode && copyStatus && navigator.clipboard) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(setupCode.textContent ?? '');
      copyStatus.textContent = 'Commands copied.';
    } catch {
      copyStatus.textContent =
        'Copy is unavailable. Select the commands above to copy them manually.';
    }
  });
}
