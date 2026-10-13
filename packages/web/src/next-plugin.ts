import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type * as ts from 'typescript-sdk';

export interface PluginStatus {
  name: string;
  state: 'active' | 'disabled' | 'unsupported' | 'failed';
  path?: string;
  reason?: string;
}

/** Audited Next plugin adapter. This is deliberately not a general tsserver project host. */
export function loadNextPlugin(
  sdk: typeof ts,
  configPath: string,
  options: ts.CompilerOptions,
  host: ts.LanguageServiceHost,
  base: ts.LanguageService,
  enabled: boolean,
) {
  let service = base;
  const plugins: PluginStatus[] = [];
  const configured = options.plugins as (ts.PluginImport & { enabled?: boolean })[] | undefined;
  for (const config of configured ?? []) {
    if (config.enabled === false) {
      plugins.push({ name: config.name, state: 'disabled' });
      continue;
    }
    if (config.name !== 'next') {
      plugins.push({
        name: config.name,
        state: 'unsupported',
        reason: `Configured TypeScript plugin ${config.name} requires a full tsserver project host and is not loaded.`,
      });
      continue;
    }
    if (!enabled) {
      plugins.push({
        name: 'next',
        state: 'disabled',
        reason:
          'Install and enable the React / Next.js package to load the configured Next.js TypeScript plugin.',
      });
      continue;
    }
    try {
      const require = createRequire(configPath);
      const path = require.resolve('next/dist/server/typescript');
      const factory = (require(path) as { createTSPlugin?: ts.server.PluginModuleFactory })
        .createTSPlugin;
      if (typeof factory !== 'function')
        throw new Error('Installed Next.js does not expose createTSPlugin.');
      const module = factory({ typescript: sdk });
      const languageService = service;
      // Next's public plugin uses only the project directory and logger from project.
      // The loaded package's source is exercised in integration tests, not reimplemented.
      const info = {
        config,
        languageService,
        languageServiceHost: host,
        serverHost: sdk.sys,
        project: {
          getCurrentDirectory: () => dirname(configPath),
          projectService: { logger: { info: () => {} } },
        },
      } as unknown as ts.server.PluginCreateInfo;
      module.create(info); // Surface initialization errors before advertising active support.
      service = new Proxy(languageService, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            // Next stores project state in module globals. Rebind on each synchronous call
            // so two app contexts sharing one node_modules tree do not contaminate each other.
            const decorated = module.create(info);
            const operation = Reflect.get(decorated, property);
            if (typeof operation !== 'function')
              throw new Error(`Next plugin does not implement ${String(property)}.`);
            return Reflect.apply(operation, decorated, args);
          };
        },
      });
      plugins.push({ name: 'next', state: 'active', path });
    } catch (error) {
      plugins.push({
        name: 'next',
        state: 'failed',
        reason: `Next.js TypeScript plugin could not load: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { service, plugins };
}
