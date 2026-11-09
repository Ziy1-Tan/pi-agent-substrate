import assert from "node:assert/strict";
import test from "node:test";

import * as grpc from "@grpc/grpc-js";

import { AteApi, checkEgressPolicy, controlService } from "../src/gateway/ateapi.js";

type Handler = (request: unknown) => { error?: grpc.status; response?: unknown };

/** An in-process Control server over the same proto the client loads. */
async function serve(
  t: test.TestContext,
  handlers: Record<string, Handler>,
  options: { channelMaxAgeMs?: number } = {},
) {
  let channels = 0;
  const received: Array<{ method: string; request: unknown }> = [];
  const server = new grpc.Server();
  const implementation: grpc.UntypedServiceImplementation = {};
  for (const method of ["CreateActor", "SuspendActor", "CreateActorEgressPolicy"]) {
    implementation[method] = (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      received.push({ method, request: call.request });
      const outcome = handlers[method]?.(call.request) ?? { response: {} };
      if (outcome.error !== undefined) callback({ code: outcome.error, details: method }, null);
      else callback(null, outcome.response ?? {});
    };
  }
  server.addService(controlService().service, implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  const api = new AteApi({
    target: `127.0.0.1:${port}`,
    template: "pi-tpl",
    credentials: () => {
      channels += 1;
      return grpc.credentials.createInsecure();
    },
    ...options,
  });
  t.after(() => {
    api.close();
    server.forceShutdown();
  });
  return { api, received, channels: () => channels };
}

const actor = { atespace: "pi-agents", name: "pi-chat" };

test("ensure creates the actor from the template in its atespace", async (t) => {
  const { api, received } = await serve(t, {});
  await api.ensure(actor);
  assert.deepEqual(received, [
    {
      method: "CreateActor",
      request: {
        actor: {
          metadata: { atespace: "pi-agents", name: "pi-chat" },
          actorTemplate: { atespace: "pi-agents", name: "pi-tpl" },
        },
      },
    },
  ]);
});

test("an actor or policy that already exists is success", async (t) => {
  const { api } = await serve(t, {
    CreateActor: () => ({ error: grpc.status.ALREADY_EXISTS }),
    CreateActorEgressPolicy: () => ({ error: grpc.status.ALREADY_EXISTS }),
  });
  await api.ensure(actor);
  await api.applyEgress(actor, { rules: [] });
});

test("the egress manifest is sent as protojson with the actor's metadata", async (t) => {
  const { api, received } = await serve(t, {});
  await api.applyEgress(actor, {
    metadata: { atespace: "elsewhere", name: "default" },
    rules: [
      {
        https: {
          hostnames: ["api.example.com"],
          ports: { numbers: [443] },
          effects: {
            replaceHeaders: [
              {
                header: "Authorization",
                prefix: "Bearer ",
                credentialUri: "ate-secret://k8s.io/default/pi-agents/pi-provider/api-key",
              },
            ],
          },
        },
      },
    ],
  });
  const request = received[0]?.request as {
    actor: unknown;
    egressPolicy: { metadata: unknown; rules: Array<{ https: { effects: unknown } }> };
  };
  assert.deepEqual(request.actor, actor);
  assert.deepEqual(request.egressPolicy.metadata, { atespace: "pi-agents", name: "default" });
  assert.deepEqual(request.egressPolicy.rules[0]?.https.effects, {
    replaceHeaders: [
      {
        header: "Authorization",
        prefix: "Bearer ",
        credentialUri: "ate-secret://k8s.io/default/pi-agents/pi-provider/api-key",
      },
    ],
  });
});

test("suspending a missing actor is success; other errors surface", async (t) => {
  let code = grpc.status.NOT_FOUND;
  const { api } = await serve(t, { SuspendActor: () => ({ error: code }) });
  await api.suspend(actor);
  code = grpc.status.PERMISSION_DENIED;
  await assert.rejects(api.suspend(actor), (error: grpc.ServiceError) => error.code === code);
});

test("the checked-in egress manifests pass the strict check", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  for (const file of ["deploy/egress-policy.yaml", "deploy/e2e/egress-policy.yaml"]) {
    const text = readFileSync(file, "utf8").replace(/\$\{[A-Z_]+\}/g, "x");
    checkEgressPolicy(parse(text) as Record<string, unknown>);
  }
});

test("an egress field the proto subset does not declare is rejected", () => {
  assert.throws(
    () =>
      checkEgressPolicy({
        rules: [{ https: { hostnames: ["a"], effects: { replaceHeader: [] } } }],
      }),
    /unknown field rules\[0\]\.https\.effects\.replaceHeader/,
  );
  checkEgressPolicy({
    rules: [
      {
        https: {
          hostnames: ["a"],
          effects: { replaceHeaders: [{ header: "X", actorJwt: { audiences: ["a"] } }] },
        },
      },
    ],
  });
});

test("calls share one channel until it ages out", async (t) => {
  const shared = await serve(t, {});
  await shared.api.ensure(actor);
  await shared.api.suspend(actor);
  assert.equal(shared.channels(), 1);

  const aging = await serve(t, {}, { channelMaxAgeMs: 0 });
  await aging.api.ensure(actor);
  await aging.api.suspend(actor);
  assert.equal(aging.channels(), 2, "an aged channel is rebuilt with fresh credentials");
});
