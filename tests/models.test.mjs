import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";
import test from "node:test";
import { MODEL_CATALOG, PROVIDERS, DEFAULT_MODEL, findModel, providerFor } from "../models.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const fallbackSource = html.match(/const FALLBACK_MODELS = (\[[\s\S]*?\n\]);/)[1];
const fallback = JSON.parse(fallbackSource);

test("catalog and offline fallback have identical models and capabilities", () => {
  assert.equal(new Set(MODEL_CATALOG.map(m => m.key)).size, MODEL_CATALOG.length);
  assert.deepEqual(fallback.map(m => m.key).sort(), MODEL_CATALOG.map(m => m.key).sort());
  for (const model of MODEL_CATALOG) {
    assert.ok(PROVIDERS[model.provider]);
    assert.deepEqual(findModel(model.provider, model.id), model);
    const { providerLabel, configured, ...offline } = fallback.find(m => m.key === model.key);
    assert.deepEqual(offline, model);
    assert.equal(providerLabel, PROVIDERS[model.provider].label);
    assert.equal(configured, false);
    assert.equal(model.vision, model.inputModalities.includes("image"));
  }
  assert.ok(DEFAULT_MODEL);
});

test("removed provider and expired routes are rejected", () => {
  assert.equal(providerFor("bai"), null);
  assert.equal(findModel("bai", "glm-5.3-flash"), null);
  assert.equal(findModel("openrouter", "stealth/space-bunny-alpha"), null);
  assert.equal(findModel("openrouter", "qwen/qwen3.8-27b:free"), null);
  for (const file of ["../render.yaml", "../.env.example", "../README.md"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /BAI_API_KEY|B\.AI/);
  }
});

test("client JavaScript parses", () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new Script(match[1]);
  }
});

test("saved removed provider and model recover to valid selections", () => {
  const source = html.match(/function renderModelControls\(\)\{[\s\S]*?\n\}/)[0];
  function element() { return { children: [], appendChild(child) { this.children.push(child); } }; }
  for (const saved of [
    { provider: "bai", model: "glm-5.3-flash" },
    { provider: "experientiallabs", model: "gpt-6-luna" },
    { provider: "openrouter", model: "stealth/space-bunny-alpha" },
  ]) {
    const settings = { ...saved };
    const context = {
      settings, modelCatalog: fallback, providerCatalog: [],
      DEFAULT_PROVIDER: DEFAULT_MODEL.provider, DEFAULT_MODEL_ID: DEFAULT_MODEL.id,
      document: { createElement: element },
      els: { providerSelect: element(), modelSelect: element(), modelCapability: element() },
      providerEntries: () => Object.values(PROVIDERS),
      selectedModel: () => fallback.find(m => m.provider === settings.provider && m.id === settings.model),
    };
    runInNewContext(source + ";renderModelControls();", context);
    assert.ok(findModel(settings.provider, settings.model));
    if (saved.provider === "bai") assert.equal(settings.provider, DEFAULT_MODEL.provider);
    else assert.equal(settings.provider, saved.provider);
  }
});
