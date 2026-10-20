# Pi-agent-substrate

Runtime traps from running against a live kind cluster; architecture is in
[docs/architecture.md](docs/architecture.md).

## Egress

An actor has no network access until an `EgressPolicy` names a destination.
A missing policy is not an error: the turn settles with no text, which is why
the manager calls `provision` first. Two other failures surface as Pi's bare
`Connection error.`

### An `http` rule does not authorize HTTPS

`Policy.SNIRules(port)` emits rules only for `https` and `tls_passthrough`, so
an `http` rule leaves `sniRules: 0` and the handshake fails with
`filter_chain_not_found`. Use `https:` for anything reached over TLS.

### An `https` rule requires trusting the egress CA

TLS terminates at the gateway, which mints a leaf from its own CA that chains
to no public root. Mount the projected bundle:

```yaml
volumes:
- name: system-info
  systemInfo:
    dataSources:
    - trustBundle:
        names: [egress-mitm.ate.dev, system-roots.ate.dev]
        path: egress-trust-bundle/trust-bundle.pem
```

and set `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` to
`/run/ate/egress-trust-bundle/trust-bundle.pem`. A missing SNI rule fails
instantly without reaching the destination; a trust failure completes the
handshake (egress byte counters move) and Pi gives up in well under a second.
Both log under `grep 'egress denied'` in `kubectl -n ate-system logs
deploy/atenet-egress -c ext-proc`.

## Credential injection

Pi sends the key in the header its wire API uses. OpenAI-compatible APIs send
`Authorization: Bearer <apiKey>`; Anthropic-compatible APIs send
`x-api-key: <apiKey>`. `models.json` carries a placeholder and the policy
replaces that header:

```yaml
# openai-completions / openai-responses
effects: {replaceHeaders: [{header: Authorization, prefix: "Bearer ",
  credentialUri: "ate-secret://k8s.io/default/<ns>/<secret>/api-key"}]}

# anthropic-messages
effects: {replaceHeaders: [{header: x-api-key,
  credentialUri: "ate-secret://k8s.io/default/<ns>/<secret>/api-key"}]}
```

Replacing the wrong header leaves the placeholder in place, and the provider
rejects the request.

The provider is default-deny: the policy ConfigMap ships as `policies: []`, so
every injection returns 403 until the atespace is listed. It reads that
ConfigMap once at startup, so restart the deployment after editing.

## Templates

### A wakeup probe disables the golden-snapshot warmup

`goldenSnapshotWarmupFor` in `cmd/ateapi/internal/controlapi/template_reconciler.go`
returns 0 when every container declares a `wakeupProbe`, and the 20s
`goldenSnapshotWarmup` constant otherwise. The reasoning is that `ResumeActor`
already blocked until the probe reported 200, so the workload must be
initialized. That holds for a service that answers its health check only once
it is fully up; it does not hold for a Node process that answers as soon as it
binds a port.

The bridge used to do the latter. `/healthz` returned 200 about 500ms after
start, so the golden actor was checkpointed at 500ms, and the restored sandbox
came back with a bridge that never listened again: the wakeup probe on the next
resume timed out after 30s, the actor went `CRASHED`, and atenet-router
answered the message with a 503. The two timings, measured on the same code:

```
with probe:     Actor started 00.814 -> Actor checkpointing 01.329   (515ms)
without probe:  Actor started 00.814 -> Actor checkpointing 30.830   (20.5s)
```

The 20s is hard-coded: no flag, env, or template field changes it. The template
therefore declares no probe, and gets the conservative wall-clock warmup.

This affects golden snapshots only. An ordinary actor is snapshotted by its
idle-suspend, long after the bridge settled, so the probe would not matter
there. It does matter for `ResumeActor`, which no longer waits for the workload
at all: fine while the template uses `SNAPSHOT_FIDELITY_MEMORY`, since the
listener comes back inside the snapshot, but a cold-start fidelity would need
the probe again.

Any replacement readiness signal has to answer two different questions, and
`/healthz` currently answers only the first: "can this port take traffic" and
"is this process safe to freeze". A signal that keeps the probe honest for
`ResumeActor` without re-enabling the 0s warmup would have to return non-200
until the process has been up for longer than the controller's 20s. The
sandbox clock keeps running across suspend — `/proc/uptime` advanced by the
wall-clock gap through a suspend/resume cycle — so process age is measurable
after a restore, but at that point the listener is already in the snapshot and
the gate buys nothing.

### A template is immutable

A template is immutable; changing the image, env, or limits needs a new name,
and `AlreadyExists` on a rerun is expected. Pin images by the platform manifest
digest: `docker inspect` reports the multi-arch index, and pulling that index
can yield a partial image that never starts, with no symptom beyond `CRASHED`
after a wakeup probe timeout.

```bash
curl -sf -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "http://localhost:5001/v2/pi-actor/manifests/local" |
  jq -r '.manifests[]|select(.platform.architecture=="arm64")|.digest'
```

## Suspend and resume

Connecting to the bridge wakes the actor, so a transport must never reconnect
on its own: one suspend becomes a permanent wake loop. The next turn's
`connect()` is the only wake signal, and a disconnect invalidates the
settled-result cache those restored actors can no longer see. `turnStarted()`
increments an in-flight count that only `turnSettled()` decrements; a failure
that skips the settle blocks every later settle and pins a worker forever, so
the gateway settles in `finally`.

## Reporting failures

Pi reports a provider failure on the final assistant message (`stopReason:
"error"` plus `errorMessage`), and an exhausted retry emits `auto_retry_end`
with `success: false` and `finalError`. Without both, a failed turn looks like
one that produced no text. The bridge sends `bridge_result` before Pi's own
`agent_settled`, because the gateway settles on the first record it sees.

Pi retries with a 2s/4s/8s backoff; set `{"retry":{"enabled":false}}` in a
test agent's `settings.json` or a one-second injected failure takes fourteen.

## Local deployment

`hack/deploy-local.sh` builds the image, creates a template from
`deploy/local/provider.env` (provider, model, endpoint, wire API, key), writes
the key to a Secret, grants the atespace access, and prints the gateway
command. The bridge composes Pi's `models.json` from the non-secret values.
Two names must match the gateway: the actor name derives from the conversation
id (`local/chat` → `pi-local-chat`),
and `PI_ACTOR_TEMPLATE` defaults to `pi-actor` while a local deploy creates
`pi-local`. BSD `sed` has no `\+`; use `-E`. `read` fails on input without a
trailing newline, which ends the script under `errexit`. zsh's nvm loader
breaks `node` in compound commands; use the absolute path or `bash`.
