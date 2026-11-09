#!/usr/bin/env bash
# Helpers shared by deploy/local.sh and deploy/e2e.sh.

# gvisor is the one class whose SandboxConfig is not named after the class.
sandbox_config_name() {
	case "$1" in
		gvisor) echo gvisor-default ;;
		*) echo "$1" ;;
	esac
}

# Prints the linux/<arch> digest of an image in the local registry.
image_digest() { # <repository> <tag> <arch>
	local repo="$1" tag="$2" arch="$3" index
	index="$(curl -sf -H 'Accept: application/vnd.oci.image.index.v1+json' \
		"http://${REGISTRY}/v2/${repo}/manifests/${tag}")" || return 1
	[[ -n "${index}" ]] || return 1
	printf '%s' "${index}" | node -e '
		let body = "";
		process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
			const [arch] = process.argv.slice(1);
			const index = JSON.parse(body);
			const match = (index.manifests ?? []).find(
				(entry) => entry.platform?.architecture === arch && entry.platform?.os === "linux",
			);
			if (match) process.stdout.write(match.digest);
		});' "${arch}"
}

# Prints the workerImage of the first WorkerPool serving a sandbox class.
worker_image_for() { # <sandbox-class>
	local class="$1" kube=(kubectl)
	[[ -n "${KUBE_CONTEXT:-}" ]] && kube+=(--context "${KUBE_CONTEXT}")
	"${kube[@]}" get workerpools -A -o json 2>/dev/null | node -e '
		let body = "";
		process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
			const [className] = process.argv.slice(1);
			let pools = [];
			try { pools = JSON.parse(body).items ?? []; } catch { return; }
			const pool = pools.find((item) =>
				(item.spec?.sandboxClasses ?? []).some((entry) => entry.name === className),
			);
			process.stdout.write(pool?.spec?.workerImage ?? "");
		});' "${class}"
}

# Renders the actor template. Expects PI_PROVIDER, PI_MODEL,
# PI_PROVIDER_BASE_URL, PI_MODEL_CONTEXT_WINDOW,
# PI_MODEL_MAX_TOKENS, PI_TOOLS, SANDBOX_CLASS_NAME, ACTOR_TEMPLATE, and ATESPACE.
render_actor_template() { # <out> <actor-image>
	ACTOR_IMAGE="$2" ACTOR_TEMPLATE="${ACTOR_TEMPLATE}" ATESPACE="${ATESPACE}" \
	PROVIDER="${PI_PROVIDER}" MODEL_ID="${PI_MODEL}" BASE_URL="${PI_PROVIDER_BASE_URL}" \
	CONTEXT_WINDOW="${PI_MODEL_CONTEXT_WINDOW:-}" \
	MAX_TOKENS="${PI_MODEL_MAX_TOKENS:-}" TOOLS="${PI_TOOLS:-none}" SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME}" \
	envsubst '${ACTOR_IMAGE} ${ACTOR_TEMPLATE} ${ATESPACE} ${PROVIDER} ${MODEL_ID} ${BASE_URL} ${CONTEXT_WINDOW} ${MAX_TOKENS} ${TOOLS} ${SANDBOX_CLASS_NAME}' \
	< deploy/actor-template.yaml > "$1"
}

GATEWAY_SPIFFE_ID="spiffe://cluster.local/ns/pi-gateway/sa/pi-gateway"

# The gateway's namespace carries the label ate-api's NetworkPolicy admits.
# Applied here, not with `create namespace`, so a rerun cannot drop the label.
apply_gateway_namespace() {
	"${kube[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: pi-gateway
  labels:
    ate.dev/api-access: "true"
YAML
}

# The gateway calls ate-api as its pod certificate's SPIFFE ID, which needs
# `editor` on the atespace to create, suspend, and set egress on actors. An
# existing policy is left alone when it already names the gateway, and refused
# otherwise: `update` replaces the whole policy, so merging is the owner's call.
grant_gateway_access() { # <kubectl-ate command...>
	local current
	# A missing policy is not an error: `get` exits 0 and prints nothing to stdout.
	current="$("$@" get access-policy -a "${ATESPACE}" -o yaml 2>/dev/null)" || current=""
	if [[ -n "${current}" ]]; then
		if printf '%s' "${current}" | grep -q "user:${GATEWAY_SPIFFE_ID}"; then return 0; fi
		echo "atespace ${ATESPACE} has an access policy without user:${GATEWAY_SPIFFE_ID}" >&2
		echo "add it as an editor: $* get access-policy -a ${ATESPACE} -o yaml, edit, then update" >&2
		return 1
	fi
	printf '%s\n' "bindings:" "- role: editor" "  members:" "  - user:${GATEWAY_SPIFFE_ID}" |
		"$@" create access-policy -a "${ATESPACE}" -f -
}

# Waits for a template's golden snapshot. ate-api reports it in
# status.goldenSnapshotStatus: a goldenTag once it is ready, an errorMessage
# once it failed, neither while it is still being taken.
wait_for_golden_snapshot() { # <template> <kubectl-ate command...>
	local template="$1" state=""
	shift
	for _ in $(seq 1 120); do
		state="$("$@" get actor-template -a "${ATESPACE}" "${template}" -o json 2>/dev/null | node -e '
			let raw = "";
			process.stdin.on("data", (chunk) => (raw += chunk)).on("end", () => {
				let parsed;
				try { parsed = JSON.parse(raw); } catch { return console.log("pending"); }
				const template = Array.isArray(parsed.actorTemplates) ? parsed.actorTemplates[0] : parsed;
				const golden = template?.status?.goldenSnapshotStatus ?? {};
				if (golden.errorMessage) console.log(`failed ${golden.errorMessage}`);
				else if (golden.goldenTag?.name) console.log(`ready ${golden.goldenTag.name}`);
				else console.log("pending");
			});
		')" || state="pending"
		case "${state}" in
		ready*)
			echo "    golden snapshot ${state#ready }"
			return 0
			;;
		failed*)
			echo "template ${ATESPACE}/${template} failed its golden snapshot: ${state#failed }" >&2
			return 1
			;;
		esac
		sleep 5
	done
	echo "template ${ATESPACE}/${template} has no golden snapshot after 10 minutes" >&2
	return 1
}
