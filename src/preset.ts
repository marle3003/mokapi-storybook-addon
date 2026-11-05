import { fileURLToPath } from 'node:url';
import { mergeConfig, type InlineConfig } from 'vite';
import { resolveOptions } from './options.js';
import type { MokapiAddonOptions } from './types.js';

function forwardingProxy(target: string, prefix: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.slice(prefix.length),
  };
}

export function previewAnnotations(entries: string[] = []): string[] {
  return [...entries, fileURLToPath(new URL('./preview.js', import.meta.url))];
}

export function managerEntries(entries: string[] = []): string[] {
  return [...entries, fileURLToPath(new URL('./manager.js', import.meta.url))];
}

export function managerHead(head = '', options?: Partial<MokapiAddonOptions>): string {
  const settings = resolveOptions(options);
  const panelOptions = JSON.stringify({
    dashboardUrl: settings.dashboardUrl,
    eventsUrl: `${settings.proxyPath}-dashboard`,
    scenarioParameter: settings.scenarioParameter,
    defaultBackend: settings.defaultBackend,
  }).replace(/</g, '\\u003c');
  return `${head}\n<script>globalThis.__MOKAPI_PANEL_OPTIONS__ = ${panelOptions};</script>`;
}

export function viteFinal(config: InlineConfig, options?: Partial<MokapiAddonOptions>): InlineConfig {
  const settings = resolveOptions(options);
  const dashboardProxyPath = `${settings.proxyPath}-dashboard`;
  return mergeConfig(config, {
    define: {
      __MOKAPI_STORYBOOK_OPTIONS__: JSON.stringify({
        proxyPath: settings.proxyPath,
        defaultBackend: settings.defaultBackend,
        scenarioParameter: settings.scenarioParameter,
        browserUrl: settings.browserUrl,
      }),
    },
    optimizeDeps: {
      include: ['storybook/internal/core-events'],
    },
    server: {
      proxy: {
        [dashboardProxyPath]: forwardingProxy(settings.dashboardUrl, dashboardProxyPath),
        [settings.proxyPath]: forwardingProxy(settings.target, settings.proxyPath),
      },
    },
  });
}
