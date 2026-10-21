# Deployment Notes

## Substrate readiness

This repository needs a working Agent Substrate installation. The smoke test
needs a WorkerPool with the `gvisor` sandbox class. Real deployments also need
a WorkerPool in atespace `pi-agents` with `workload: pi`.

```sh
kubectl config current-context
kubectl -n ate-system get svc atenet-router
kubectl get workerpools -A -o custom-columns='NAMESPACE:.metadata.namespace,CLASS:.spec.sandboxClasses[*].name,WORKLOAD:.metadata.labels.workload,IMAGE:.spec.workerImage'
kubectl-ate get atespace pi-agents
```

If `pi-agents` is missing, create it with
`kubectl-ate create atespace pi-agents`. If no gVisor pool appears, create one
before running the smoke test. The pool's `IMAGE` must come from a registry the
cluster can pull; `localhost:5001` is the default for local kind.

## Local tools

The scripts need Node.js 22 or newer, Docker, `kubectl`, `kubectl-ate`,
`envsubst`, `jq`, and `curl`.

```sh
node --version && docker version --format '{{.Server.Version}}' &&
kubectl version --client && kubectl-ate --version &&
envsubst --version | head -1 && jq --version && curl --version | head -1
```

Set `KUBE_CONTEXT` for a non-default cluster.

## Gateway Deployment

The Deployment has a ServiceAccount, a PVC for the conversation log, a Secret
for the bot token, and RBAC for the shared `ate-client` identity. The PVC keeps
that log across pod restarts.

The Pod reaches the router at `ws://atenet-router.ate-system.svc:80`, so it
needs no port-forward. To inspect it:

```sh
kubectl -n pi-agents get deploy pi-gateway
kubectl -n pi-agents logs deploy/pi-gateway -f
kubectl -n pi-agents exec deploy/pi-gateway -- \
  curl -sS http://127.0.0.1:8788/metrics
```

`GET /metrics` returns JSON counters and p50/p95 timing windows. Counters reset
when the gateway process restarts; timing summaries keep the most recent 200
samples. Counters include `turns`, `resumed_turns`, `suspends`,
`suspend_failures`, and `idle_windows`; timings include `turn_millis`,
`first_token_millis`, and `resume_millis`.

## Actor settings

The actor template receives the provider endpoint and wire API. The API key is
injected by egress, not stored in the template.

OpenAI-compatible APIs use `Authorization: Bearer`; Anthropic-compatible APIs
use `x-api-key`. An `https:` rule is required for a TLS provider, and the
template mounts the egress trust bundle because TLS terminates at the gateway.

The actor supports `PI_BRIDGE_ARGS`, `PI_CODING_AGENT_DIR`, `PI_SESSION_DIR`,
`PI_SESSION_ID`, and `PI_BRIDGE_CWD`. These are template settings. Project
context, skills, and session files belong under `/workspace`.

`PI_BRIDGE_ARGS` passes extra Pi CLI flags; it splits on whitespace and does not
handle shell quoting. Set session paths with `PI_SESSION_DIR` and
`PI_SESSION_ID`, not through those flags.

The bridge writes one provider and one model to `/workspace/.pi/models.json`.
It does not load another Pi model catalog.

The gateway image bundles a `kubectl-ate` client built from Substrate commit
`bce845180740e07cf08b63060ebeead8de3204cc`. That is the tested client
baseline, not a pin on the installed Substrate version.

## Snapshots

The template requests `SNAPSHOT_FIDELITY_MEMORY`, which usually restores the Pi
process warm. DATA fidelity restores cold and continues from session files.

The template has no wakeup probe: the bridge answers `/healthz` before Pi
finishes loading, so the controller uses its 20s golden-snapshot warmup
instead. See the runtime traps in [AGENTS.md](../AGENTS.md).
