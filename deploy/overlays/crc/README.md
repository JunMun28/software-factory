# OpenShift Local (CRC) overlay

`oc apply -k deploy/overlays/crc` after one-time cluster prep (all as
kubeadmin, findings from the 2026-07-19 E2E-7 port):

1. Codex auth: `oc -n software-factory create secret generic sf-codex-auth
   --from-file=auth.json=$HOME/.codex/auth.json`
2. Kaniko needs in-container root (its whole point is avoiding privileged
   mode, not avoiding root): `oc adm policy add-scc-to-user anyuid -z
   sf-build -n software-factory`. Office answer stays BuildConfig
   (pre-recorded deviation).
3. The NODE pulls produced-app images from the in-cluster registry, and
   cri-o resolves via the VM resolver, not cluster DNS:
   - inside the VM: `echo "<sf-registry ClusterIP> sf-registry" | sudo tee
     -a /etc/hosts`
   - `oc patch image.config.openshift.io/cluster --type=merge -p
     '{"spec":{"registrySources":{"insecureRegistries":["sf-registry:5000"]}}}'`
     (crio picks it up in ~1 min).
4. Factory images live in the internal registry
   (`<default-route>/software-factory/sf-{api,console,intake,agent}:dev`);
   push via `docker save ... | skopeo copy --dest-tls-verify=false`.

Run the journey with `KUBECONFIG=<crc kubeconfig> scripts/crc-smoke-golden.sh`.
