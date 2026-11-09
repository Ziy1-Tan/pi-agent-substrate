# Pi-agent-substrate

Traps found by running against a live kind cluster. Each one is something the
code and the docs around it do not show. Architecture is in
[docs/architecture.md](docs/architecture.md), setup in [README.md](README.md),
and the reason behind each manifest field sits in a comment next to it.

## Egress failures

An actor without an `EgressPolicy` gets no error. Its turn settles with no
text, and that is why the gateway calls `applyEgress` before the first message.

Two other egress mistakes both surface as Pi's bare `Connection error.`:

- An `http` rule does not authorize HTTPS. `Policy.SNIRules(port)` emits rules
  only for `https` and `tls_passthrough`, so an `http` rule leaves
  `sniRules: 0` and the handshake fails with `filter_chain_not_found`. This
  fails instantly and never reaches the destination.
- An untrusted egress CA (see the trust-bundle comment in
  `deploy/actor-template.yaml`) gets through the handshake. The egress byte
  counters move, and Pi gives up in well under a second.

Both are logged under `grep 'egress denied'` in
`kubectl -n ate-system logs deploy/atenet-egress -c ext-proc`.

## Golden snapshots and the wakeup probe

`goldenSnapshotWarmupFor` in
`cmd/ateapi/internal/controlapi/template_reconciler.go` (Substrate) returns 0
when every container declares a `wakeupProbe`. Otherwise it returns the
hard-coded 20s `goldenSnapshotWarmup`, and no flag, env, or template field
changes that value. The bridge's `/healthz` answers about 500ms after start.
With a probe declared, the golden actor was checkpointed at 500ms, and the
restored bridge never listened again. The next resume's probe timed out after
30s, the actor went `CRASHED`, and atenet-router answered with a 503:

```
with probe:     Actor started 00.814 -> Actor checkpointing 01.329   (515ms)
without probe:  Actor started 00.814 -> Actor checkpointing 30.830   (20.5s)
```

So the template declares no probe. That position is fragile. Upstream dropped a
tunable warmup (#487) in favour of honest readiness endpoints, and #2068 moves
toward requiring a probe on every container. If that lands, `/healthz` must
return 503 until the process is older than the warmup. Process age survives a
restore (`/proc/uptime` advanced by the wall-clock gap across a
suspend/resume), so a restored actor passes the gate at once and only a cold
start waits. A cold-start snapshot fidelity would need the same change, since
`ResumeActor` no longer waits for the workload.

## Gateway access to ate-api

The gateway calls ate-api as its pod certificate's SPIFFE ID, so it needs no
Kubernetes RBAC. Two things outside the code decide whether a call gets
through. A namespace without the `ate.dev/api-access=true` label is dropped by
ate-api's NetworkPolicy, which looks like a gRPC timeout rather than a denial.
Deleting an atespace deletes its access policy, so a recreated atespace denies
the gateway until `deploy/` grants it again.

A denied call names the principal with `:` percent-encoded; decode it before
putting it in a policy.

always-on-agent shells out to `kubectl-ate` because its GKE cluster gives a
plain Deployment no pod certificate. That reason does not apply here.

## Local environment

- `kubectl ate delete actor` no longer accepts `--any-state`.
- Running the gateway by hand: `ACTOR_TEMPLATE` defaults to `pi-actor` in
  `src/gateway/main.ts`, while `deploy/local.sh` creates `pi-local-v1-0-0`.
- A stale `ateom-microvm:latest` in the local registry rejects the
  controller's `--pod-ips` flag. On this host the deploy needs
  `WORKER_IMAGE=localhost:5001/ateworker-microvm:v1.0.0`.
- `read` fails on input without a trailing newline, which ends a script under
  `errexit`.
- zsh's nvm loader breaks `node` in compound commands. Use `bash -lc` or the
  absolute binary path.
