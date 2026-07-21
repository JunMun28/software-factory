import { createHash } from 'node:crypto';

import type {
  SandboxHandle,
  SandboxProvider,
  SandboxStartOptions,
} from './sandbox.js';

/**
 * KubeSandbox — the cloud twin of {@link LocalProcessSandbox}. Instead of
 * spawning child processes on localhost it runs each chat's dev server as a
 * Kubernetes Deployment + Service (image `sf-ngv0-sandbox:dev`, contract in
 * app-preview/sandbox/) in the `software-factory` namespace, and targets the
 * bridge proxy at the Service DNS name.
 *
 * The logic (manifest shape, slug derivation, rollout/frontend waiting, resync
 * POST, teardown selector) is separated from the concrete k8s wire calls behind
 * {@link KubeSandboxClient}, exactly as the factory separates `kube_client` from
 * its runner logic — so the whole provider is unit-testable against a fake.
 */

// ---------------------------------------------------------------- constants ---

export const DEFAULT_SANDBOX_IMAGE = 'sf-ngv0-sandbox:dev';
export const DEFAULT_GIT_REMOTE = 'git://ng-v0-orchestrator:9418';
export const DEFAULT_SANDBOX_NAMESPACE = 'software-factory';
/** Restricted-SCC UID, matching the produced-app / agent-Job convention. */
export const SANDBOX_RUN_AS_UID = 10101;
export const FRONTEND_PORT = 8080;
export const RESYNC_PORT = 8090;

/** npm install + `ng serve` is slow; give the frontend a long time to answer. */
const DEFAULT_READY_TIMEOUT_MS = 5 * 60 * 1000;
/** The Deployment (backed by the :8090 resync readiness probe) comes up fast. */
const DEFAULT_ROLLOUT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;

// -------------------------------------------------------------------- types ---

/** A plain-JSON k8s object. Kept structural so the builder stays pure. */
export interface KubeManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec?: unknown;
}

export interface SandboxManifests {
  deployment: KubeManifest;
  service: KubeManifest;
}

export interface SandboxManifestOptions {
  image?: string;
  gitRemote?: string;
}

export interface SandboxHttpResponse {
  status: number;
  body?: string;
}

/**
 * The thin wire seam. A real implementation talks to the k8s API + the pod's
 * HTTP endpoints; the unit tests pass a fake that records calls.
 */
export interface KubeSandboxClient {
  /** Create-or-replace a Deployment/Service manifest (idempotent). */
  apply(manifest: KubeManifest): Promise<void>;
  /** Delete every resource matching a `key=value` label selector. */
  deleteByLabel(selector: string): Promise<void>;
  /** Resolve true once the named Deployment reports its replicas ready. */
  rolloutReady(deploymentName: string, timeoutMs: number): Promise<boolean>;
  /** GET a URL; must resolve (status 0 on a network error) rather than throw. */
  httpGet(url: string): Promise<SandboxHttpResponse>;
  /** POST a URL with an optional JSON body. */
  httpPost(url: string, body?: string): Promise<SandboxHttpResponse>;
}

export interface KubeSandboxOptions {
  client: KubeSandboxClient;
  namespace?: string;
  image?: string;
  gitRemote?: string;
  /** Frontend-answers timeout (the slow part). Default ~5 min. */
  readyTimeoutMs?: number;
  /** Deployment-rollout timeout. Default ~2 min. */
  rolloutTimeoutMs?: number;
  pollMs?: number;
  /**
   * Host-routed previews: the base domain each sandbox's preview host hangs off.
   * When set, start() returns `previewHost = <slug>.<previewDomain>` and an
   * `externalPreviewUrl` so the orchestrator's main server proxies by Host. Empty
   * (the default) means no host routing (targetUrl only).
   */
  previewDomain?: string;
  /** Browser-facing port for the preview URL. Empty → omitted (default 80). */
  previewExternalPort?: string;
}

// -------------------------------------------------------------------- slug ---

const RFC1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_SLUG_LEN = 40;

/**
 * Deterministic RFC1123 name for a chat's sandbox resources: lowercase,
 * `[a-z0-9-]`, <= 40 chars. A chat id that is already a clean short id is used
 * verbatim; anything else is sanitised and given a stable hash suffix so two
 * different ids never collide.
 */
export function sandboxSlug(chatId: string): string {
  if (RFC1123.test(chatId) && chatId.length <= MAX_SLUG_LEN) {
    return chatId;
  }
  const suffix = `-${createHash('sha1').update(chatId).digest('hex').slice(0, 8)}`;
  let base = chatId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const maxBase = MAX_SLUG_LEN - suffix.length;
  if (base.length > maxBase) {
    base = base.slice(0, maxBase).replace(/-+$/g, '');
  }
  if (!base) {
    base = 's';
  }
  return `${base}${suffix}`;
}

/** `sf-sandbox-<slug>` — the shared name of a chat's Deployment + Service. */
export function sandboxResourceName(chatId: string): string {
  return `sf-sandbox-${sandboxSlug(chatId)}`;
}

// --------------------------------------------------------------- manifests ---

/**
 * Pure builder: the Deployment + Service for one chat's sandbox. No I/O, no
 * namespace (the client scopes calls to a namespace) — trivially unit-testable.
 */
export function sandboxManifests(
  chatId: string,
  opts: SandboxManifestOptions = {},
): SandboxManifests {
  const slug = sandboxSlug(chatId);
  const name = `sf-sandbox-${slug}`;
  const image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
  const gitRemote = opts.gitRemote ?? DEFAULT_GIT_REMOTE;

  const labels = { 'sf/tier': 'sandbox', 'sf/session': slug, app: name };
  const selector = { app: name };

  const deployment: KubeManifest = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: selector },
      // Scratch pod: never wait to drain the old one, never keep two around.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          // Pod runs user-influenced code (cloned workspace) — restricted SCC.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: SANDBOX_RUN_AS_UID,
            runAsGroup: 0,
            fsGroup: 0,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'sandbox',
              image,
              imagePullPolicy: 'IfNotPresent',
              env: [
                { name: 'CHAT_ID', value: chatId },
                { name: 'GIT_REMOTE', value: gitRemote },
              ],
              ports: [
                { name: 'http', containerPort: FRONTEND_PORT },
                { name: 'resync', containerPort: RESYNC_PORT },
              ],
              // The resync server (:8090) answers before the dev server is up,
              // so it gates readiness. It is generous on purpose: the pod also
              // spends minutes on `npm install` + `ng serve` before the
              // frontend (:8080) truly serves — start() waits on that below.
              readinessProbe: {
                httpGet: { path: '/healthz', port: RESYNC_PORT },
                initialDelaySeconds: 10,
                periodSeconds: 10,
                timeoutSeconds: 3,
                failureThreshold: 30,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              resources: {
                requests: { cpu: '250m', memory: '512Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
            },
          ],
        },
      },
    },
  };

  const service: KubeManifest = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, labels },
    spec: {
      selector,
      ports: [
        { name: 'http', port: FRONTEND_PORT, targetPort: FRONTEND_PORT },
        { name: 'resync', port: RESYNC_PORT, targetPort: RESYNC_PORT },
      ],
    },
  };

  return { deployment, service };
}

// ---------------------------------------------------------------- provider ---

export class KubeSandbox implements SandboxProvider {
  private readonly client: KubeSandboxClient;
  private readonly namespace: string;
  private readonly image: string;
  private readonly gitRemote: string;
  private readonly readyTimeoutMs: number;
  private readonly rolloutTimeoutMs: number;
  private readonly pollMs: number;
  private readonly previewDomain: string;
  private readonly previewExternalPort: string;

  constructor(options: KubeSandboxOptions) {
    this.client = options.client;
    this.namespace = options.namespace ?? DEFAULT_SANDBOX_NAMESPACE;
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.gitRemote = options.gitRemote ?? DEFAULT_GIT_REMOTE;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.rolloutTimeoutMs =
      options.rolloutTimeoutMs ?? DEFAULT_ROLLOUT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.previewDomain = options.previewDomain ?? '';
    this.previewExternalPort = options.previewExternalPort ?? '';
  }

  async start(
    chatId: string,
    _options: SandboxStartOptions = {},
  ): Promise<SandboxHandle> {
    const slug = sandboxSlug(chatId);
    const name = `sf-sandbox-${slug}`;
    const selector = `sf/session=${slug}`;
    const { deployment, service } = sandboxManifests(chatId, {
      image: this.image,
      gitRemote: this.gitRemote,
    });

    try {
      await this.client.apply(deployment);
      await this.client.apply(service);

      const rolled = await this.client.rolloutReady(
        name,
        this.rolloutTimeoutMs,
      );
      if (!rolled) {
        throw new Error(
          `sandbox ${slug}: deployment not ready within ${this.rolloutTimeoutMs}ms`,
        );
      }

      const targetUrl = `http://${name}.${this.namespace}.svc.cluster.local:${FRONTEND_PORT}`;
      const resyncUrl = `http://${name}.${this.namespace}.svc.cluster.local:${RESYNC_PORT}/resync`;

      const frontendReady = await this.waitForFrontend(targetUrl);
      if (!frontendReady) {
        throw new Error(
          `sandbox ${slug}: frontend did not answer within ${this.readyTimeoutMs}ms`,
        );
      }

      // Host-routed preview: the orchestrator's main server proxies any request
      // whose Host is `<slug>.<previewDomain>` to targetUrl. Only set when a
      // domain is configured; otherwise the handle carries targetUrl alone.
      const previewHost = this.previewDomain
        ? `${slug}.${this.previewDomain}`
        : undefined;
      const externalPreviewUrl = previewHost
        ? `http://${previewHost}${
            this.previewExternalPort ? `:${this.previewExternalPort}` : ''
          }/`
        : undefined;

      return {
        targetUrl,
        previewHost,
        externalPreviewUrl,
        resync: async (sha?: string): Promise<void> => {
          const body = sha ? JSON.stringify({ sha }) : undefined;
          const res = await this.client.httpPost(resyncUrl, body);
          if (res.status < 200 || res.status >= 300) {
            throw new Error(
              `sandbox ${slug}: resync failed (HTTP ${res.status})`,
            );
          }
        },
        stop: async (): Promise<void> => {
          await this.client.deleteByLabel(selector);
        },
      } satisfies SandboxHandle;
    } catch (error) {
      // Best-effort teardown so a failed start leaves nothing behind.
      await this.client.deleteByLabel(selector).catch(() => {});
      throw error;
    }
  }

  private async waitForFrontend(targetUrl: string): Promise<boolean> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const res = await this.client.httpGet(`${targetUrl}/`);
      if (res.status === 200) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(this.pollMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------- namespace + real client ---

/**
 * Namespace the sandbox pods live in: `FACTORY_KUBE_NAMESPACE` then
 * `APPVIEW_KUBE_NAMESPACE`, defaulting to `software-factory`.
 */
export function resolveSandboxNamespace(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.FACTORY_KUBE_NAMESPACE ??
    env.APPVIEW_KUBE_NAMESPACE ??
    DEFAULT_SANDBOX_NAMESPACE
  );
}

/**
 * The real k8s client: in-cluster config, AppsV1/CoreV1 create-or-replace, and
 * label-scoped delete-collection with Foreground propagation. Kept thin and
 * import-lazy so the unit tests (which use a fake) never load the k8s SDK.
 */
export async function createKubeSandboxClient(
  namespace: string,
): Promise<KubeSandboxClient> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromCluster();
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);

  const isConflict = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === 409;

  const swallowMissing = (err: unknown): void => {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: number }).code === 404
    ) {
      return;
    }
    throw err;
  };

  return {
    async apply(manifest: KubeManifest): Promise<void> {
      const name = manifest.metadata.name;
      if (manifest.kind === 'Deployment') {
        const body = manifest as unknown as import('@kubernetes/client-node').V1Deployment;
        try {
          await appsApi.createNamespacedDeployment({ namespace, body });
        } catch (err) {
          if (!isConflict(err)) throw err;
          const existing = await appsApi.readNamespacedDeployment({
            name,
            namespace,
          });
          body.metadata = {
            ...body.metadata,
            resourceVersion: existing.metadata?.resourceVersion,
          };
          await appsApi.replaceNamespacedDeployment({ name, namespace, body });
        }
      } else if (manifest.kind === 'Service') {
        const body = manifest as unknown as import('@kubernetes/client-node').V1Service;
        try {
          await coreApi.createNamespacedService({ namespace, body });
        } catch (err) {
          if (!isConflict(err)) throw err;
          const existing = await coreApi.readNamespacedService({
            name,
            namespace,
          });
          body.metadata = {
            ...body.metadata,
            resourceVersion: existing.metadata?.resourceVersion,
          };
          await coreApi.replaceNamespacedService({ name, namespace, body });
        }
      } else {
        throw new Error(`KubeSandbox cannot apply kind ${manifest.kind}`);
      }
    },

    async deleteByLabel(selector: string): Promise<void> {
      const opts = {
        namespace,
        labelSelector: selector,
        propagationPolicy: 'Foreground',
      };
      await appsApi
        .deleteCollectionNamespacedDeployment(opts)
        .catch(swallowMissing);
      await coreApi
        .deleteCollectionNamespacedService(opts)
        .catch(swallowMissing);
    },

    async rolloutReady(
      deploymentName: string,
      timeoutMs: number,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const dep = await appsApi
          .readNamespacedDeployment({ name: deploymentName, namespace })
          .catch(() => null);
        const ready = dep?.status?.readyReplicas ?? 0;
        const desired = dep?.spec?.replicas ?? 1;
        if (ready > 0 && ready >= desired) {
          return true;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await sleep(DEFAULT_POLL_MS);
      }
    },

    async httpGet(url: string): Promise<SandboxHttpResponse> {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3_000),
        });
        return { status: res.status, body: await res.text() };
      } catch {
        return { status: 0 };
      }
    },

    async httpPost(url: string, body?: string): Promise<SandboxHttpResponse> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
