import { fileURLToPath } from 'node:url';
import { mergeConfig, type InlineConfig } from 'vite';
import { resolveOptions } from './options.js';
import type { MokapiAddonOptions } from './types.js';

// First, so the Mokapi afterEach runs last: Storybook runs the project's afterEach hooks in reverse order of the
// annotation files. The Mokapi hook waits for the validations, so other addons' checks must not wait for it.
export function previewAnnotations(entries: string[] = []): string[] {
  return [fileURLToPath(new URL('./preview.js', import.meta.url)), ...entries];
}

export function managerEntries(entries: string[] = []): string[] {
  return [...entries, fileURLToPath(new URL('./manager.js', import.meta.url))];
}

export function managerHead(head = '', options?: Partial<MokapiAddonOptions>): string {
  const { dashboardUrl, defaultValidation } = resolveOptions(options);
  const panelOptions = JSON.stringify({ dashboardUrl, defaultValidation }).replace(/</g, '\\u003c');
  return `${head}\n<script>globalThis.__MOKAPI_PANEL_OPTIONS__ = ${panelOptions};</script>`;
}

export function viteFinal(config: InlineConfig, options?: Partial<MokapiAddonOptions>): InlineConfig {
  return mergeConfig(config, {
    define: { __MOKAPI_STORYBOOK_OPTIONS__: JSON.stringify(resolveOptions(options)) },
  });
}
