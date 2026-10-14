import { describe, expect, it } from 'vitest';
import { fileIconKind } from './file-icons';

describe('fileIconKind', () => {
  it('picks the icon from the extension', () => {
    expect(fileIconKind('/repo/cmd/main.go')).toEqual({ shape: 'code', type: 'go' });
    expect(fileIconKind('src/App.tsx')).toEqual({ shape: 'code', type: 'ts' });
    expect(fileIconKind('config.JSON')).toEqual({ shape: 'braces', type: 'json' });
    expect(fileIconKind('README.md')).toEqual({ shape: 'text', type: 'markdown' });
  });

  it('recognises well-known file names before extensions', () => {
    expect(fileIconKind('go.sum')).toEqual({ shape: 'lock', type: 'lock' });
    expect(fileIconKind('package-lock.json')).toEqual({ shape: 'lock', type: 'lock' });
    expect(fileIconKind('build/Dockerfile.dev')).toEqual({ shape: 'container', type: 'docker' });
    expect(fileIconKind('.env.local')).toEqual({ shape: 'config', type: 'config' });
  });

  it('falls back to a plain file', () => {
    expect(fileIconKind('LICENSE')).toEqual({ shape: 'plain', type: 'plain' });
    expect(fileIconKind('.hidden')).toEqual({ shape: 'plain', type: 'plain' });
    expect(fileIconKind('notes.unknown')).toEqual({ shape: 'plain', type: 'plain' });
  });
});
