#!/usr/bin/env bash
# Helpers shared by scripts/deploy-local.sh and scripts/e2e/kind.sh.

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
# PI_PROVIDER_BASE_URL, PI_PROVIDER_API, PI_MODEL_CONTEXT_WINDOW,
# PI_MODEL_MAX_TOKENS, SANDBOX_CLASS_NAME, ACTOR_TEMPLATE, and ATESPACE.
render_actor_template() { # <out> <actor-image>
	local out="$1" image="$2"
	sed -e "s#\${ACTOR_IMAGE}#${image}#" \
	    -e "s#\${PROVIDER}#${PI_PROVIDER}#" \
	    -e "s#\${MODEL_ID}#${PI_MODEL}#" \
	    -e "s#\${BASE_URL}#${PI_PROVIDER_BASE_URL}#" \
	    -e "s#\${API}#${PI_PROVIDER_API}#" \
	    -e "s#\${CONTEXT_WINDOW}#${PI_MODEL_CONTEXT_WINDOW:-}#" \
	    -e "s#\${MAX_TOKENS}#${PI_MODEL_MAX_TOKENS:-}#" \
	    -e "s#\${SANDBOX_CLASS_NAME}#${SANDBOX_CLASS_NAME}#" \
	    deploy/e2e/actor-template.json.tmpl > "${out}"
	sed -i.bak -e "s#^  name: pi-actor\$#  name: ${ACTOR_TEMPLATE}#" \
	    -e "s#^  atespace: pi-agents\$#  atespace: ${ATESPACE}#" "${out}"
	rm -f "${out}.bak"
}
