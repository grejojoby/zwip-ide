import type { Extension } from '@codemirror/state';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as common from '@lezer/common';
import * as highlight from '@lezer/highlight';
import * as lr from '@lezer/lr';
import { request } from '../api';
import { builtinKey, builtinSyntax } from './builtin-syntax';

const runtime = {
  '@codemirror/state': state,
  '@codemirror/view': view,
  '@codemirror/language': language,
  '@codemirror/autocomplete': autocomplete,
  '@lezer/common': common,
  '@lezer/highlight': highlight,
  '@lezer/lr': lr,
};
Object.defineProperty(globalThis, '__zwipSyntaxRuntime', {
  value: Object.freeze(runtime),
  configurable: true,
});
const loaded = new Map<string, Promise<Extension>>();
type SyntaxModule = { createSyntax(extension: string): Extension };
const factories = new Map<string, Promise<SyntaxModule>>();
const listeners = new Set<() => void>();
let generation = 0;
window.addEventListener('zwip:packages-changed', () => {
  generation++;
  loaded.clear();
  for (const changed of listeners) changed();
});
export function observeSyntaxChanges(changed: () => void): () => void {
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
  };
}
interface SyntaxAsset {
  id: string;
  version: string;
  abi: number;
  source: string;
  sha256: string;
}
/** Only checked, enabled package assets supply language-specific editor behavior. */
export function syntaxFor(path: string): Promise<Extension> {
  const extension = path.split('.').pop() ?? '';
  const key = builtinKey(path);
  const existing = loaded.get(key);
  if (existing) return existing;
  const current = generation;
  const loading = (async () => {
    // JSON remains a core configuration-file convenience, independent of language packages.
    if (extension === 'json') return (await import('@codemirror/lang-json')).json();
    const asset = await request<SyntaxAsset | null>('package.syntax', { extension });
    if (current !== generation) return [];
    // Enabled packages supply their own grammar; otherwise the app's built-in one applies.
    if (!asset) return (await builtinSyntax(path)) ?? [];
    if (asset.abi !== 1) throw new Error('Unsupported package syntax ABI');
    const bytes = new TextEncoder().encode(asset.source);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== asset.sha256) throw new Error('Syntax asset checksum mismatch');
    let factory = factories.get(digest);
    if (!factory) {
      factory = (async () => {
        const url = URL.createObjectURL(new Blob([asset.source], { type: 'text/javascript' }));
        try {
          const module = (await import(/* @vite-ignore */ url)) as SyntaxModule;
          if (typeof module.createSyntax !== 'function') throw new Error('Invalid syntax provider');
          return module;
        } finally {
          URL.revokeObjectURL(url);
        }
      })();
      factories.set(digest, factory);
    }
    const module = await factory;
    return current === generation ? module.createSyntax(extension) : [];
  })();
  loaded.set(key, loading);
  return loading;
}
