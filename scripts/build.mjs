import { build } from 'vite';
import { createExtensionBuildConfig, EXTENSION_ENTRIES } from '../vite.config.mjs';

const watch = process.argv.includes('--watch');

async function run() {
  for (const entry of EXTENSION_ENTRIES) {
    await build(createExtensionBuildConfig({ ...entry, watch }));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
