import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { readIdentity, type IdentityPaths } from "./identity.js";

/** A conversation's actor, as ate-api names it. */
export interface ActorRef {
  atespace: string;
  name: string;
}

/** What the gateway asks of the control plane. Resume is absent: the router resumes on connect. */
export type ActorControl = Pick<AteApi, "ensure" | "applyEgress" | "suspend">;

/** An EgressPolicy manifest in protojson form (camelCase), as `kubectl ate` accepts it. */
export type EgressPolicyManifest = Record<string, unknown>;

const PROTO_PATH = fileURLToPath(new URL("../../../proto/ateapi.proto", import.meta.url));
const PACKAGE = "substrate.ateapi.v1";

type Callback = (error: grpc.ServiceError | null, response?: unknown) => void;
type Method = (request: unknown, options: grpc.CallOptions, callback: Callback) => void;
type ControlClient = grpc.Client & Record<string, Method>;
type ControlConstructor = new (
  target: string,
  credentials: grpc.ChannelCredentials,
  options: grpc.ChannelOptions,
) => ControlClient;

interface FieldDescriptor {
  name: string;
  type: string;
  typeName: string;
}
type Descriptors = Record<string, { type?: { field: FieldDescriptor[] } }>;

function load(): Descriptors {
  return protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    defaults: false,
  }) as unknown as Descriptors;
}

/** Loads the Control service; exported so tests can serve the same definition. */
export function controlService(): grpc.ServiceClientConstructor {
  const loaded = grpc.loadPackageDefinition(load() as protoLoader.PackageDefinition) as unknown as {
    substrate: { ateapi: { v1: { Control: grpc.ServiceClientConstructor } } };
  };
  return loaded.substrate.ateapi.v1.Control;
}

/**
 * Rejects a manifest field the proto subset does not declare. protobufjs drops
 * unknown fields silently, so without this a typo or an upstream field missing
 * here would reach ate-api as an empty value instead of failing like
 * `kubectl ate` does.
 */
export function checkEgressPolicy(policy: EgressPolicyManifest): void {
  const descriptors = load();
  const visit = (value: unknown, typeName: string, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, typeName, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`${path || "egress policy"}: expected an object`);
    }
    const fields = descriptors[`${PACKAGE}.${typeName}`]?.type?.field ?? [];
    for (const [key, child] of Object.entries(value)) {
      const field = fields.find((candidate) => candidate.name === key);
      const where = path ? `${path}.${key}` : key;
      if (!field) throw new Error(`egress policy: unknown field ${where}`);
      if (field.type === "TYPE_MESSAGE") visit(child, field.typeName, where);
    }
  };
  visit(policy, "EgressPolicy", "");
}

export interface AteApiOptions {
  /** gRPC target, e.g. `dns:///api.ate-system.svc:443`. */
  target: string;
  /** Template a missing actor is created from, in the actor's atespace. */
  template: string;
  /** Read when the channel is (re)built, so a rotated pod certificate is picked up. */
  credentials: () => grpc.ChannelCredentials;
  timeoutMs?: number;
  /** How long a channel is reused before it is rebuilt with fresh credentials. */
  channelMaxAgeMs?: number;
}

/**
 * ate-api's Control service over gRPC. `api` is a headless Service, so the
 * channel balances round-robin across the replicas DNS returns rather than
 * pinning to the first. One channel is shared and rebuilt after
 * `channelMaxAgeMs`, which bounds how long a rotated certificate goes unused.
 */
export class AteApi {
  private readonly options: AteApiOptions;
  private readonly Control: ControlConstructor;
  private client: { value: ControlClient; createdAt: number } | undefined;

  constructor(options: AteApiOptions) {
    this.options = options;
    this.Control = controlService() as unknown as ControlConstructor;
  }

  /** Creates the actor; one that already exists is success. */
  async ensure(actor: ActorRef): Promise<void> {
    await this.call("CreateActor", {
      actor: {
        metadata: { atespace: actor.atespace, name: actor.name },
        actorTemplate: { atespace: actor.atespace, name: this.options.template },
      },
    }).catch(allow(grpc.status.ALREADY_EXISTS));
  }

  /** Asks for a suspend. A suspended actor is returned as it is; a missing one is success. */
  async suspend(actor: ActorRef): Promise<void> {
    await this.call("SuspendActor", { actor }).catch(allow(grpc.status.NOT_FOUND));
  }

  /** Creates the actor's egress policy; one that already exists is kept. */
  async applyEgress(actor: ActorRef, policy: EgressPolicyManifest): Promise<void> {
    await this.call("CreateActorEgressPolicy", {
      actor,
      egressPolicy: { ...policy, metadata: { atespace: actor.atespace, name: "default" } },
    }).catch(allow(grpc.status.ALREADY_EXISTS));
  }

  close(): void {
    this.client?.value.close();
    this.client = undefined;
  }

  private channel(): ControlClient {
    const maxAge = this.options.channelMaxAgeMs ?? 10 * 60_000;
    if (this.client && Date.now() - this.client.createdAt < maxAge) return this.client.value;
    this.client?.value.close();
    const value = new this.Control(this.options.target, this.options.credentials(), {
      "grpc.service_config": JSON.stringify({ loadBalancingConfig: [{ round_robin: {} }] }),
    });
    this.client = { value, createdAt: Date.now() };
    return value;
  }

  private call(method: string, request: unknown): Promise<unknown> {
    const client = this.channel();
    const deadline = Date.now() + (this.options.timeoutMs ?? 30_000);
    return new Promise((resolve, reject) => {
      client[method]!.call(client, request, { deadline }, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  }
}

/** mTLS with the pod certificate; ate-api's principal is then the pod's SPIFFE ID. */
export function podCertificateCredentials(paths: IdentityPaths): () => grpc.ChannelCredentials {
  return () => {
    const identity = readIdentity(paths);
    return grpc.credentials.createSsl(
      Buffer.from(identity.ca),
      Buffer.from(identity.key),
      Buffer.from(identity.cert),
    );
  };
}

function allow(code: grpc.status): (error: unknown) => void {
  return (error) => {
    if ((error as Partial<grpc.ServiceError>).code !== code) throw error;
  };
}
