# Troubleshooting

Start by separating the gateway, actor, router, and provider layers.

## Conversation log

Each turn appends `inbound`, `job_dispatched`, `outbound`, and `job_completed`
to `channel.jsonl`. A failure ends in `job_failed`.

| Last event | What to check |
|---|---|
| No `inbound` | The gateway is not polling, or `PI_TELEGRAM_CHATS` filters out the chat. |
| `inbound` without `job_dispatched` | The gateway queue is not moving. |
| `job_dispatched` without `outbound` | The actor, router, or provider failed. |
| `job_failed` | Read the record's `error` field. |

Start with the gateway and actor state:

```sh
kubectl -n pi-agents logs deploy/pi-gateway --tail=200
kubectl -n pi-agents exec deploy/pi-gateway -- \
  /usr/local/bin/kubectl-ate get actors -a pi-agents
```

The conversation log lives in the gateway Pod under
`/data/accounts/telegram/channels/<chat-id>/channel.jsonl`.

For a `503` after `job_dispatched`, inspect the router and worker logs before
changing the gateway deployment.

## Empty replies and egress

An actor without egress can settle without text. Check its state, then read its
container logs. The actor name comes from the conversation id:

```sh
kubectl-ate logs actors pi-local-chat -a pi-agents --source containers
```

For egress denials and TLS trust failures, see
[the egress notes](../AGENTS.md#egress). The actor trusts the projected bundle
in the template. Credential injection is default-deny: `deploy-local.sh`
grants the namespace and restarts the credential provider. If the provider
reports `403`, check that policy before changing the gateway.

## Pi process

The bridge logs Pi stderr as `pi stderr:` and child exits as `pi exited`.
These lines come from the actor container, not the gateway.

If `/healthz` answers before Pi finishes loading, a golden snapshot can contain
a bridge that never listens again. The template therefore omits `wakeupProbe`;
see [the template notes](../AGENTS.md#templates) before adding one.

## Crashed actor

The gateway does not retry a `CRASHED` actor. Revert it to its latest snapshot,
which discards current execution and leaves the external snapshot intact:

```sh
kubectl-ate revert actor pi-local-chat -a pi-agents
```

The next message resumes that snapshot. Session files under `/workspace/.pi`
remain either way.

If revert is not appropriate, delete the actor and let the gateway create a
new one from the template.
