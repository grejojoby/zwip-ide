import { buildWebPackage } from '../packages/web/build.mjs';
import { buildGoPackage } from '../packages/go/build.mjs';
await buildWebPackage();
await buildGoPackage();

const { buildToolsPackages } = await import('../packages/tools/build.mjs');
await buildToolsPackages();

const { buildReactNextPackage } = await import('../packages/react-next/build.mjs');
await buildReactNextPackage();
