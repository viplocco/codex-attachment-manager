// Purpose: the cc-switch corrector's rewrite rules: only base_url lines that name a cc-switch source are replaced,
// only while the attachment manager's managed block is present, and everything else stays byte for byte the same.

import assert from "node:assert/strict";
import test from "node:test";
import { CC_SWITCH_SOURCES, ENGINE_URL, MANAGED_BEGIN, rewriteConfig, sourceKey } from "../../integrations/cc-switch/corrector.mjs";

const configText = (baseUrl: string, extra = "") => [
  MANAGED_BEGIN,
  'openai_base_url = "http://localhost:17891/backend-api/codex"',
  "# <<< codex-attachment-manager <<<",
  "",
  'model_provider = "custom"',
  "",
  "[model_providers.custom]",
  'name = "OpenAI"',
  `base_url = "${baseUrl}"`,
  'wire_api = "responses"',
  extra,
  "",
].join("\n");

test("the cc-switch base_url is put back to the engine", () => {
  const result = rewriteConfig(configText("http://127.0.0.1:15721/v1"));
  assert.equal(result.changed, true);
  assert.match(result.text, new RegExp(`base_url = "${ENGINE_URL.replace(/[/.:]/g, "\\$&")}"`));
  assert.doesNotMatch(result.text, /15721/);
  assert.deepEqual(result.changes, [{ section: "model_providers.custom", key: "base_url", from: "http://127.0.0.1:15721/v1", to: ENGINE_URL }]);
});

test("a config without the managed block is left alone", () => {
  const text = configText("http://127.0.0.1:15721/v1").split(MANAGED_BEGIN).join("").replace("# <<< codex-attachment-manager <<<\n\n", "");
  const result = rewriteConfig(text);
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test("other providers and unrelated settings stay untouched", () => {
  const text = [
    MANAGED_BEGIN,
    'openai_base_url = "http://localhost:17891/backend-api/codex"',
    "# <<< codex-attachment-manager <<<",
    "[model_providers.custom]",
    'base_url = "http://127.0.0.1:15721/v1"',
    "[model_providers.other]",
    'base_url = "http://127.0.0.1:15721/v1"',
    "[projects.'e:\\project']",
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const result = rewriteConfig(text);
  assert.match(result.text, /\[model_providers\.custom\]\nbase_url = "http:\/\/localhost:17891\/v1"/);
  assert.match(result.text, /\[model_providers\.other\]\nbase_url = "http:\/\/127\.0\.0\.1:15721\/v1"/);
  assert.match(result.text, /trust_level = "trusted"/);
});

test("a top-level openai_base_url that cc-switch rewrote is put back too", () => {
  const text = [MANAGED_BEGIN, 'openai_base_url = "http://127.0.0.1:15721/v1"', "# <<< codex-attachment-manager <<<", ""].join("\n");
  const result = rewriteConfig(text);
  assert.match(result.text, /openai_base_url = "http:\/\/localhost:17891\/backend-api\/codex"/);
});

test("CRLF line endings and trailing comments survive a rewrite", () => {
  const text = [`${MANAGED_BEGIN}`, 'openai_base_url = "http://localhost:17891/backend-api/codex"', "# <<< codex-attachment-manager <<<", "[model_providers.custom]", 'base_url = "http://localhost:15721/v1" # cc-switch', ""].join("\r\n");
  const result = rewriteConfig(text);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("\r\n"));
  assert.match(result.text, /base_url = "http:\/\/localhost:17891\/v1" # cc-switch/);
});

test("source keys ignore the scheme and path but keep host and port", () => {
  assert.equal(sourceKey("http://127.0.0.1:15721/v1"), "127.0.0.1:15721");
  assert.equal(sourceKey("localhost:15721"), "localhost:15721");
  assert.equal(sourceKey("https://example.com"), "example.com:443");
  assert.deepEqual(CC_SWITCH_SOURCES, ["127.0.0.1:15721", "localhost:15721"]);
});
