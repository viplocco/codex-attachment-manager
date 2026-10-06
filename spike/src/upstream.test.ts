// Purpose: the engine's upstream setting: default ChatGPT backend, explicit HTTP(S) origins, path joining,
// loopback detection and argument precedence. Output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { isLoopback, parseUpstream, upstreamHostHeader, upstreamLabel, upstreamPath, upstreamSetting } from "../../plugin/src/upstream.ts";

test("the upstream defaults to the ChatGPT backend", () => {
  assert.equal(upstreamLabel(parseUpstream(null)), "https://chatgpt.com");
  assert.equal(upstreamLabel(parseUpstream("")), "https://chatgpt.com");
  assert.equal(upstreamLabel(parseUpstream("chatgpt.com")), "http://chatgpt.com");
});

test("an HTTP upstream keeps its host, port and path", () => {
  const upstream = parseUpstream("http://127.0.0.1:15721");
  assert.equal(upstream.host, "127.0.0.1");
  assert.equal(upstream.port, 15721);
  assert.equal(upstream.secure, false);
  assert.equal(upstreamLabel(upstream), "http://127.0.0.1:15721");
  assert.equal(upstreamHostHeader(upstream), "127.0.0.1:15721");
  assert.equal(isLoopback(upstream), true);
});

test("a bare host name gets http and the scheme's default port", () => {
  const upstream = parseUpstream("127.0.0.1:8080");
  assert.equal(upstream.secure, false);
  assert.equal(upstream.port, 8080);
  assert.equal(upstreamLabel(parseUpstream("localhost")), "http://localhost");
  assert.equal(upstreamLabel(parseUpstream("https://example.com/")), "https://example.com");
  assert.equal(upstreamLabel(parseUpstream("https://example.com:8443/base/")), "https://example.com:8443/base");
});

test("an upstream path is joined ahead of the request path exactly once", () => {
  const plain = parseUpstream("http://127.0.0.1:15721");
  assert.equal(upstreamPath(plain, "/v1/responses"), "/v1/responses");
  const base = parseUpstream("http://127.0.0.1:15721/gateway");
  assert.equal(upstreamPath(base, "/v1/responses"), "/gateway/v1/responses");
  assert.equal(upstreamPath(base, "v1/responses"), "/gateway/v1/responses");
  assert.equal(upstreamPath(base, "/gateway/v1/responses"), "/gateway/v1/responses");
  assert.equal(upstreamPath(base, "/gateway"), "/gateway");
});

test("--upstream wins over CAM_UPSTREAM_URL and the environment is the fallback", () => {
  assert.equal(upstreamSetting({ CAM_UPSTREAM_URL: "http://127.0.0.1:15721" }, ["node", "proxy.ts"]), "http://127.0.0.1:15721");
  assert.equal(upstreamSetting({ CAM_UPSTREAM_URL: "http://127.0.0.1:15721" }, ["node", "proxy.ts", "--upstream", "http://127.0.0.1:9999"]), "http://127.0.0.1:9999");
  assert.equal(upstreamSetting({}, ["node", "proxy.ts"]), null);
});
