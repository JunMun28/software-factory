import { createServer, type Server } from 'node:http';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { previewProxyMiddleware } from '../src/http/preview-proxy.js';
import {
  PreviewManager,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStartOptions,
} from '../src/preview-manager.js';
import { FakePortAllocator } from './fake-preview-deps.js';

const TARGET =
  'http://sf-sandbox-req-1.software-factory.svc.cluster.local:8080';
const PREVIEW_HOST = 'req-1.preview.example.com';
const EXTERNAL_URL = 'http://req-1.preview.example.com:8443/';

/** A kube-style provider whose handle carries previewHost + externalPreviewUrl. */
class HostRoutedSandboxProvider implements SandboxProvider {
  readonly stopped: string[] = [];
  async start(
    chatId: string,
    _options?: SandboxStartOptions,
  ): Promise<SandboxHandle> {
    return {
      targetUrl: TARGET,
      previewHost: PREVIEW_HOST,
      externalPreviewUrl: EXTERNAL_URL,
      resync: async () => {},
      stop: async () => {
        this.stopped.push(chatId);
      },
    } satisfies SandboxHandle;
  }
}

/** A local-style provider whose handle has NO externalPreviewUrl. */
class LocalStyleSandboxProvider implements SandboxProvider {
  async start(): Promise<SandboxHandle> {
    return {
      targetUrl: 'http://localhost:41999',
      resync: async () => {},
      stop: async () => {},
    } satisfies SandboxHandle;
  }
}

function makeBridge() {
  return {
    starts: [] as Array<{ targetUrl: string; port: number }>,
    async start(input: { targetUrl: string; port: number }) {
      this.starts.push(input);
      return { url: `http://localhost:${input.port}`, async close() {} };
    },
  };
}

function makeManager(provider: SandboxProvider, bridge = makeBridge()) {
  const manager = new PreviewManager({
    workspacesRoot: '/unused',
    previewRoot: '/unused',
    sandboxProvider: provider,
    portAllocator: new FakePortAllocator(),
    bridgeProxy: bridge,
  } as never);
  return { manager, bridge };
}

describe('PreviewManager host-routed previews (kube)', () => {
  it('reports the external URL, starts NO localhost bridge, and registers the host', async () => {
    const { manager, bridge } = makeManager(new HostRoutedSandboxProvider());

    await manager.ensure('req-1');

    expect(manager.status('req-1')).toMatchObject({
      status: 'ready',
      url: EXTERNAL_URL,
    });
    // Host-routed previews never spin up the per-chat localhost bridge.
    expect(bridge.starts).toEqual([]);
    expect(manager.resolvePreviewTarget(PREVIEW_HOST)).toBe(TARGET);
  });

  it('resolvePreviewTarget is case- and port-insensitive, and misses safely', async () => {
    const { manager } = makeManager(new HostRoutedSandboxProvider());
    await manager.ensure('req-1');

    expect(manager.resolvePreviewTarget('REQ-1.Preview.Example.COM')).toBe(
      TARGET,
    );
    expect(manager.resolvePreviewTarget('req-1.preview.example.com:8443')).toBe(
      TARGET,
    );
    expect(manager.resolvePreviewTarget('other.example.com')).toBeUndefined();
    expect(manager.resolvePreviewTarget(undefined)).toBeUndefined();
    expect(manager.resolvePreviewTarget('')).toBeUndefined();
  });

  it('unregisters the host after stop()', async () => {
    const { manager } = makeManager(new HostRoutedSandboxProvider());
    await manager.ensure('req-1');
    expect(manager.resolvePreviewTarget(PREVIEW_HOST)).toBe(TARGET);

    await manager.stop('req-1');

    expect(manager.resolvePreviewTarget(PREVIEW_HOST)).toBeUndefined();
    expect(manager.status('req-1').status).toBe('stopped');
  });
});

describe('PreviewManager local previews stay on the localhost bridge', () => {
  it('starts the bridge and never registers a preview host', async () => {
    const { manager, bridge } = makeManager(new LocalStyleSandboxProvider());

    await manager.ensure('local-chat');

    // FakePortAllocator hands out 45000 first for the bridge port.
    expect(bridge.starts).toEqual([
      { targetUrl: 'http://localhost:41999', port: 45000 },
    ]);
    expect(manager.status('local-chat')).toMatchObject({
      status: 'ready',
      url: 'http://localhost:45000',
    });
    expect(manager.resolvePreviewTarget('local-chat')).toBeUndefined();
    expect(manager.resolvePreviewTarget('anything.example.com')).toBeUndefined();
  });
});

describe('previewProxyMiddleware', () => {
  it('proxies a known host with overlay injection, and falls through otherwise', async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><body><main>Preview App</main></body></html>');
    });
    const port = await listen(upstream);
    const target = `http://127.0.0.1:${port}`;

    const stub = {
      resolvePreviewTarget: (host: string | undefined | null) =>
        host && host.split(':')[0].toLowerCase() === PREVIEW_HOST
          ? target
          : undefined,
    };
    const app = new Hono();
    app.use('*', previewProxyMiddleware(stub));
    app.get('*', (c) => c.text('api-route'));

    try {
      const previewRes = await app.request('/', {
        headers: { host: PREVIEW_HOST },
      });
      expect(previewRes.status).toBe(200);
      const html = await previewRes.text();
      expect(html).toContain('<main>Preview App</main>');
      expect(html).toContain('data-ng-v0-design-bridge');

      const apiRes = await app.request('/models', {
        headers: { host: 'orchestrator.local' },
      });
      expect(await apiRes.text()).toBe('api-route');
    } finally {
      upstream.closeAllConnections();
      upstream.close();
    }
  });

  it('forwards the request path + query to the sandbox target', async () => {
    let seenUrl = '';
    const upstream = createServer((req, res) => {
      seenUrl = req.url ?? '';
      res.setHeader('content-type', 'application/javascript');
      res.end('console.log(1)');
    });
    const port = await listen(upstream);
    const target = `http://127.0.0.1:${port}`;

    const app = new Hono();
    app.use(
      '*',
      previewProxyMiddleware({
        resolvePreviewTarget: (host) => (host ? target : undefined),
      }),
    );
    app.get('*', (c) => c.text('api-route'));

    try {
      const res = await app.request('/assets/app.js?v=2', {
        headers: { host: PREVIEW_HOST },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('console.log(1)');
      expect(seenUrl).toBe('/assets/app.js?v=2');
    } finally {
      upstream.closeAllConnections();
      upstream.close();
    }
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(address.port);
    });
  });
}
