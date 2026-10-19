# Notes for agents working in this repository

Operational knowledge that is not visible from the code. Everything here
was learned by running against a real kind cluster with a real provider;
each item cost time to find the first time.

Architecture and design live in [docs/architecture.md](docs/architecture.md).
This file only records the traps.

## Egress

An actor has no network access until an `EgressPolicy` names a destination.
Two independent failures produce the same symptom — Pi reports a bare
`Connection error.` — so check both before looking anywhere else.

### An `http` rule does not authorize HTTPS

`http:` in a policy allows cleartext only. `Policy.SNIRules(port)` emits SNI
rules for `https` and `tls_passthrough` and skips `http` entirely, so an
`http` rule against an HTTPS endpoint leaves `sniRules: 0`. The egress data
plane then answers the TLS handshake with
`chain: denied, details: filter_chain_not_found`, and Pi surfaces nothing
more useful than a connection error.

Use `https:` for anything reached over TLS, including an OpenAI-compatible
endpoint at an `https://` base URL.

```bash
kubectl -n ate-system logs deploy/atenet-egress -c ext-proc | grep 'egress denied'
# look for sniRules in the "egress tunnel opened" line; 0 means the rule type is wrong
```

### An `https` rule requires trusting the egress CA

An `https` rule terminates TLS at the gateway, which mints a leaf for the
destination from its own CA. That chain reaches no public root, so Node
rejects it. The actor needs the projected trust bundle mounted and pointed
at by the runtime:

```yaml
volumes:
- name: system-info
  systemInfo:
    dataSources:
    - trustBundle:
        names: [egress-mitm.ate.dev, system-roots.ate.dev]
        path: egress-trust-bundle/trust-bundle.pem
```

and the container needs:

```yaml
- name: NODE_EXTRA_CA_CERTS
  value: /run/ate/egress-trust-bundle/trust-bundle.pem
- name: SSL_CERT_FILE
  value: /run/ate/egress-trust-bundle/trust-bundle.pem
```

The bundle is re-resolved on every Run/Restore; a runtime that reads it once
sees a rotation at the next resume.

To tell the two failures apart: a `filter_chain_not_found` failure is
instant and never reaches the destination. A trust failure shows a completed
handshake in the egress byte counters (`up_bytes`, `down_bytes`, `code: 200`)
followed by Pi giving up in well under a second.

### One policy per actor, applied after the actor exists

`EgressPolicy` is nested under an actor, not under the atespace. A gateway
that creates an actor and forgets the policy gets a turn that completes with
no text — the provider call is denied, Pi retries, and then settles empty.
That is why the manager calls its `provision` hook before the first turn.

## Credential injection

The model key does not need to enter the actor. Pi sends
`Authorization: Bearer <apiKey>` by default, so the key in `models.json` can
be a placeholder, and the policy replaces the header on the way out:

```yaml
rules:
- https:
    hostnames: [tokenhub.example.com]
    effects:
      replaceHeaders:
      - header: Authorization
        prefix: "Bearer "
        credentialUri: ate-secret://k8s.io/default/<namespace>/<secret>/api-key
```

Injection works only on an `http` or `https` rule that is the deciding rule
for the request, and the actor must send the header. Failures are fail-closed:
403 for a missing secret or an unauthorized atespace, 503 if the provider is
unreachable.

### The credential provider is default-deny

`k8s-credential-provider-namespace-policy` ships with `policies: []`. Until
the actor's atespace is listed with the secret's namespace, every injection
fails with 403. The provider reads this ConfigMap once at startup, so
editing it alone changes nothing; restart the deployment.

`hack/deploy-local.sh` does both, and is idempotent.

## Actor templates

### A template is immutable

Changing the image, env, or resource limits means a new template name. Rerunning
a deploy script against an existing name fails with `AlreadyExists`; that is
expected, not a bug.

### Pin the image by the platform manifest digest

`docker inspect` reports the digest of the multi-arch index. A node that
pulls that index can end up with a partial image whose container never starts.
The only symptom is an actor that goes `CRASHED` after a wakeup probe timeout,
with no application log at all.

Resolve the child manifest for the node's platform instead:

```bash
curl -sf -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "http://localhost:5001/v2/pi-actor/manifests/local" |
  jq -r '.manifests[] | select(.platform.architecture=="arm64" and .platform.os=="linux") | .digest'
```

`hack/deploy-local.sh` does this and pins `name@sha256:...`.

## Suspend and resume

### Connecting wakes the actor, so never reconnect automatically

A suspended actor is woken by the next connection to its bridge. A transport
that reconnects on its own therefore turns one suspend into a permanent
suspend/wake loop, and the actor never sleeps through a full idle window.
The next turn's `connect()` is the only wake signal.

### A dropped connection invalidates cached turn results

The settled-result cache lives in the bridge process. A suspend removes that
process, so results from before the suspend are invisible to the restored
actor. A reused result would mark a turn as done that never ran, so
`PiBackend` clears the cache on disconnect.

### A failed turn must still settle the lifecycle

`turnStarted()` increments the in-flight count and `turnSettled()` decrements
it. If a failure skips the settle, the count stays at one. Every later settle
is then blocked, the state machine never reaches `GRACE`, and the actor never
suspends again; one provider hiccup would pin a worker. The gateway wraps the
turn in `try/finally` so every exit settles exactly once.

## Reporting failures

Pi reports a provider failure on the final assistant message:
`stopReason: "error"` with `errorMessage`, and an exhausted retry loop emits
`auto_retry_end` with `success: false` and `finalError`. Ignoring these makes
a failed turn indistinguishable from one that produced no text.

The bridge sends `bridge_result` before Pi's own `agent_settled`, because
the gateway settles on the first record it sees. A bare `agent_settled`
arriving first would settle the turn with empty text.

Pi retries transient errors by default (2s/4s/8s backoff). In a
failure-injection test that turns a one-second failure into a fourteen-second
one; write `{"retry":{"enabled":false}}` into the test agent's
`settings.json`.

## Local deployment

`hack/deploy-local.sh` builds the actor image, creates a template from one
provider in `~/.pi/agent/models.json`, writes the key to a Secret, grants the
atespace access to it, and prints the gateway command.

- The actor name is derived from the conversation id (`local/chat` →
  `pi-local-chat`), matching the gateway's mapping. Creating an actor under
  any other name leaves it unused.
- The printed command includes `PI_ACTOR_TEMPLATE`; the gateway defaults to
  `pi-actor`, which a local deployment does not create.
- BSD `sed` does not understand `\+`. Use `-E` for `+` quantifiers.
- `read` returns non-zero on input without a trailing newline, which ends the
  script under `errexit`.

## Environment

On this workstation zsh's nvm loader breaks `node` inside compound commands.
Use the absolute path (`~/.nvm/versions/node/v22.19.0/bin/node`) or run the
script under `bash`.
