// Purpose: the engine as a local HTTP reverse proxy: a request for Codex reaches the configured upstream with its
// path, headers and body, and the response comes back unchanged. A real engine is started on a spare port with a
// synthetic upstream, so no network and no Codex are involved.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { engineHealth, ensureEngine } from "../../plugin/src/engine.ts";

test("the engine forwards Codex's request to the configured HTTP upstream", async (t) => {
  const received: Array<{ url: string | undefined; host: string | undefined; authorization: string | undefined; body: string }> = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, path: request.url, echoed: Buffer.concat(chunks).toString("utf8") }));
    });
  });
  await new Promise<void>((ready) => upstream.listen(0, "127.0.0.1", ready));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  t.after(() => upstream.close());

  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env.CAM_DATA_DIR = mkdtempSync(join(tmpdir(), "cam-upstream-"));
  t.after(() => { delete process.env.CAM_DATA_DIR; });
  const started = await ensureEngine({ port, upstream: `http://127.0.0.1:${upstreamPort}`, extraArgs: ["--stay"] });
  assert.equal(started.state, "started");
  t.after(() => { try { process.kill(started.health!.pid); } catch { /* already gone */ } });

  assert.equal((await engineHealth(port))?.upstream, `http://127.0.0.1:${upstreamPort}`);
  const answer = await fetch(`http://127.0.0.1:${port}/v1/models?limit=1`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({ ping: true }),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, path: "/v1/models?limit=1", echoed: '{"ping":true}' });
  assert.deepEqual(received, [{ url: "/v1/models?limit=1", host: `127.0.0.1:${upstreamPort}`, authorization: "Bearer test-token", body: '{"ping":true}' }]);
});

test("changing the upstream replaces an engine that runs the same code", async (t) => {
  const upstreamPort = 20000 + Math.floor(Math.random() * 20000);
  const port = 10000 + Math.floor(Math.random() * 10000);
  process.env.CAM_DATA_DIR = mkdtempSync(join(tmpdir(), "cam-upstream-"));
  t.after(() => { delete process.env.CAM_DATA_DIR; });
  const first = await ensureEngine({ port, upstream: "http://127.0.0.1:1", extraArgs: ["--stay"] });
  assert.equal(first.state, "started");
  t.after(() => { try { process.kill(first.health!.pid); } catch { /* already gone */ } });
  const next = await ensureEngine({ port, upstream: `http://127.0.0.1:${upstreamPort}`, extraArgs: ["--stay"] });
  assert.equal(next.state, "replaced");
  assert.equal(next.replaced?.pid, first.health!.pid);
  assert.equal(next.health?.upstream, `http://127.0.0.1:${upstreamPort}`);
  t.after(() => { try { process.kill(next.health!.pid); } catch { /* already gone */ } });
});
