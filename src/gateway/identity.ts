import { readFileSync } from "node:fs";

/** Files of the gateway's projected pod identity. */
export interface IdentityPaths {
  /** CA bundle that verifies the router's and ate-api's serving certificates. */
  ca: string;
  /** podCertificate credential bundle: the private key, then the certificate chain. */
  bundle: string;
}

export interface Identity {
  ca: string;
  cert: string;
  key: string;
}

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Node rejects the combined bundle as `cert` ("no start line") because the key
 * comes first, so the blocks are split. Callers read this per connection:
 * the kubelet rotates the files.
 */
export function readIdentity(paths: IdentityPaths): Identity {
  const bundle = readFileSync(paths.bundle, "utf8");
  return {
    ca: readFileSync(paths.ca, "utf8"),
    cert: bundle.match(CERTIFICATE_BLOCK)?.join("\n") ?? "",
    key: bundle.match(PRIVATE_KEY_BLOCK)?.[0] ?? "",
  };
}
