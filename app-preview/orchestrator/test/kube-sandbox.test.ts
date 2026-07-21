import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GIT_REMOTE,
  DEFAULT_SANDBOX_IMAGE,
  KubeSandbox,
  type KubeManifest,
  type KubeSandboxClient,
  type SandboxHttpResponse,
  resolveSandboxNamespace,
  sandboxManifests,
  sandboxSlug,
} from '../src/kube-sandbox.js';

// A recording fake for the k8s wire seam. Rollout + frontend readiness are
// programmable so start() can be driven down both the happy and timeout paths.
interface FakeCall {
  kind: 'apply' | 'delete' | 'rollout' | 'get' | 'post';
  arg: string;
  body?: string;
}

class FakeKubeClient implements KubeSandboxClient {
  readonly calls: FakeCall[] = [];
  readonly applied: KubeManifest[] = [];
  rolloutResult = true;
  frontendStatus = 200;
  resyncStatus = 200;

  async apply(manifest: KubeManifest): Promise<void> {
    this.applied.push(manifest);
    this.calls.push({ kind: 'apply', arg: manifest.kind });
  }

  async deleteByLabel(selector: string): Promise<void> {
    this.calls.push({ kind: 'delete', arg: selector });
  }

  async rolloutReady(name: string): Promise<boolean> {
    this.calls.push({ kind: 'rollout', arg: name });
    return this.rolloutResult;
  }

  async httpGet(url: string): Promise<SandboxHttpResponse> {
    this.calls.push({ kind: 'get', arg: url });
    return { status: this.frontendStatus };
  }

  async httpPost(url: string, body?: string): Promise<SandboxHttpResponse> {
    this.calls.push({ kind: 'post', arg: url, body });
    return { status: this.resyncStatus };
  }
}

describe('sandboxSlug', () => {
  it('passes a clean short chat id through unchanged and is deterministic', () => {
    expect(sandboxSlug('req-2046')).toBe('req-2046');
    expect(sandboxSlug('req-2046')).toBe('req-2046');
    expect(sandboxSlug('abc123')).toBe('abc123');
  });

  it('lowercases + sanitises + hash-suffixes an unclean id, stably', () => {
    const a = sandboxSlug('REQ-2046');
    const b = sandboxSlug('REQ-2046');
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/); // RFC1123
    expect(a).toContain('req-2046');
    // A different input never collides with the same sanitised base.
    expect(sandboxSlug('req/2046')).not.toBe(sandboxSlug('req_2046'));
  });

  it('always yields an RFC1123 name of at most 40 chars', () => {
    const inputs = [
      'chat',
      'a very long chat id with SPACES and Weird*Chars/here-and-there!!',
      'UPPER_CASE_UNDERSCORES',
      '....leading-dots....',
      'x'.repeat(200),
      '汉字-chat',
    ];
    for (const input of inputs) {
      const slug = sandboxSlug(input);
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
  });
});

describe('sandboxManifests', () => {
  const { deployment, service } = sandboxManifests('req-2046');

  it('names and labels both resources sf-sandbox-<slug> with the sandbox tier', () => {
    expect(deployment.metadata.name).toBe('sf-sandbox-req-2046');
    expect(service.metadata.name).toBe('sf-sandbox-req-2046');
    for (const m of [deployment, service]) {
      expect(m.metadata.labels).toMatchObject({
        'sf/tier': 'sandbox',
        'sf/session': 'req-2046',
        app: 'sf-sandbox-req-2046',
      });
    }
  });

  it('runs one sf-ngv0-sandbox:dev container with CHAT_ID + GIT_REMOTE and both ports', () => {
    const spec = deployment.spec as Record<string, any>;
    expect(spec.replicas).toBe(1);
    const container = spec.template.spec.containers[0];
    expect(container.image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(container.imagePullPolicy).toBe('IfNotPresent');
    expect(container.env).toEqual([
      { name: 'CHAT_ID', value: 'req-2046' },
      { name: 'GIT_REMOTE', value: DEFAULT_GIT_REMOTE },
    ]);
    expect(container.ports.map((p: any) => p.containerPort).sort()).toEqual([
      8080, 8090,
    ]);
    expect(container.readinessProbe.httpGet).toEqual({
      path: '/healthz',
      port: 8090,
    });
    // Generous readiness — dev server takes minutes to serve.
    expect(container.readinessProbe.failureThreshold).toBeGreaterThanOrEqual(20);
  });

  it('applies the restricted securityContext and heavy dev-server resources', () => {
    const spec = (deployment.spec as Record<string, any>).template.spec;
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10101,
      fsGroup: 0,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    const container = spec.containers[0];
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    });
    expect(container.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '1', memory: '1Gi' },
    });
  });

  it('exposes 8080 (http) + 8090 (resync) with a selector matching the pod labels', () => {
    const dspec = deployment.spec as Record<string, any>;
    const sspec = service.spec as Record<string, any>;
    expect(sspec.selector).toEqual(dspec.selector.matchLabels);
    // The selector must be a subset of the pod's labels so it routes to them.
    expect(dspec.template.metadata.labels).toMatchObject(sspec.selector);
    expect(sspec.ports).toEqual([
      { name: 'http', port: 8080, targetPort: 8080 },
      { name: 'resync', port: 8090, targetPort: 8090 },
    ]);
  });

  it('honours image + gitRemote overrides', () => {
    const { deployment: d } = sandboxManifests('req-1', {
      image: 'custom:tag',
      gitRemote: 'git://elsewhere:9418',
    });
    const container = (d.spec as Record<string, any>).template.spec
      .containers[0];
    expect(container.image).toBe('custom:tag');
    expect(container.env).toContainEqual({
      name: 'GIT_REMOTE',
      value: 'git://elsewhere:9418',
    });
  });
});

describe('KubeSandbox.start', () => {
  it('applies deployment + service, waits for rollout + frontend, and targets the Service DNS', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({
      client,
      namespace: 'software-factory',
      pollMs: 0,
    });

    const handle = await sandbox.start('req-2046');

    expect(handle.targetUrl).toBe(
      'http://sf-sandbox-req-2046.software-factory.svc.cluster.local:8080',
    );
    // Deployment applied before Service, then rollout, then frontend GET.
    const kinds = client.calls.map((c) => c.kind);
    expect(kinds).toEqual(['apply', 'apply', 'rollout', 'get']);
    expect(client.applied.map((m) => m.kind)).toEqual([
      'Deployment',
      'Service',
    ]);
    const getCall = client.calls.find((c) => c.kind === 'get');
    expect(getCall?.arg).toBe(
      'http://sf-sandbox-req-2046.software-factory.svc.cluster.local:8080/',
    );
  });

  it('uses the default software-factory namespace in the target URL', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({ client, pollMs: 0 });
    const handle = await sandbox.start('req-7');
    expect(handle.targetUrl).toBe(
      'http://sf-sandbox-req-7.software-factory.svc.cluster.local:8080',
    );
  });

  it('tears down and throws when the rollout never becomes ready', async () => {
    const client = new FakeKubeClient();
    client.rolloutResult = false;
    const sandbox = new KubeSandbox({ client, pollMs: 0, rolloutTimeoutMs: 5 });

    await expect(sandbox.start('req-2046')).rejects.toThrow(/not ready/);
    expect(client.calls.some((c) => c.kind === 'delete')).toBe(true);
  });

  it('tears down and throws when the frontend never answers 200', async () => {
    const client = new FakeKubeClient();
    client.frontendStatus = 503;
    const sandbox = new KubeSandbox({ client, pollMs: 0, readyTimeoutMs: 5 });

    await expect(sandbox.start('req-2046')).rejects.toThrow(/frontend/);
    const del = client.calls.find((c) => c.kind === 'delete');
    expect(del?.arg).toBe('sf/session=req-2046');
  });
});

describe('KubeSandbox handle resync + stop', () => {
  it('POSTs the resync endpoint with the sha and deletes by the session selector', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({
      client,
      namespace: 'software-factory',
      pollMs: 0,
    });
    const handle = await sandbox.start('req-2046');

    await handle.resync('deadbeef');
    const post = client.calls.find((c) => c.kind === 'post');
    expect(post?.arg).toBe(
      'http://sf-sandbox-req-2046.software-factory.svc.cluster.local:8090/resync',
    );
    expect(post?.body).toBe(JSON.stringify({ sha: 'deadbeef' }));

    await handle.stop();
    const del = client.calls.find((c) => c.kind === 'delete');
    expect(del?.arg).toBe('sf/session=req-2046');
  });

  it('resync without a sha sends no body, and a non-2xx resync throws', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({ client, pollMs: 0 });
    const handle = await sandbox.start('req-2046');

    await handle.resync();
    const post = client.calls.find((c) => c.kind === 'post');
    expect(post?.body).toBeUndefined();

    client.resyncStatus = 500;
    await expect(handle.resync('abc123')).rejects.toThrow(/resync failed/);
  });
});

describe('KubeSandbox host-routed preview', () => {
  it('builds previewHost + externalPreviewUrl from previewDomain + port', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({
      client,
      namespace: 'software-factory',
      pollMs: 0,
      previewDomain: 'preview.example.com',
      previewExternalPort: '8443',
    });

    const handle = await sandbox.start('req-2046');

    expect(handle.previewHost).toBe('req-2046.preview.example.com');
    expect(handle.externalPreviewUrl).toBe(
      'http://req-2046.preview.example.com:8443/',
    );
    // The in-cluster Service target is unchanged — host routing is additive.
    expect(handle.targetUrl).toBe(
      'http://sf-sandbox-req-2046.software-factory.svc.cluster.local:8080',
    );
  });

  it('omits the :port when previewExternalPort is empty', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({
      client,
      pollMs: 0,
      previewDomain: 'preview.example.com',
    });

    const handle = await sandbox.start('req-7');

    expect(handle.externalPreviewUrl).toBe('http://req-7.preview.example.com/');
  });

  it('leaves host fields undefined when no previewDomain is configured', async () => {
    const client = new FakeKubeClient();
    const sandbox = new KubeSandbox({ client, pollMs: 0 });

    const handle = await sandbox.start('req-7');

    expect(handle.previewHost).toBeUndefined();
    expect(handle.externalPreviewUrl).toBeUndefined();
  });
});

describe('resolveSandboxNamespace', () => {
  it('prefers FACTORY_KUBE_NAMESPACE, then APPVIEW_KUBE_NAMESPACE, then default', () => {
    expect(resolveSandboxNamespace({ FACTORY_KUBE_NAMESPACE: 'a' })).toBe('a');
    expect(resolveSandboxNamespace({ APPVIEW_KUBE_NAMESPACE: 'b' })).toBe('b');
    expect(
      resolveSandboxNamespace({
        FACTORY_KUBE_NAMESPACE: 'a',
        APPVIEW_KUBE_NAMESPACE: 'b',
      }),
    ).toBe('a');
    expect(resolveSandboxNamespace({})).toBe('software-factory');
  });
});
