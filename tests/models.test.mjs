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

test("2026-10-20 free catalog includes new routes and rejects withdrawn or paid alternatives",()=>{
  const openrouter=MODEL_CATALOG.filter(m=>m.provider==="openrouter");
  assert.equal(openrouter.length,18);
  for(const [id,vision] of [
    ["minimax/minimax-m3.1-flash:free",true],
    ["xingchen-agi/xing4.0-29b-a4b:free",false],
    ["nvidia/nemotron-3.5-super-vl:free",true],
  ]){
    const model=findModel("openrouter",id);assert.ok(model);assert.equal(model.vision,vision);assert.equal(model.supportsTools,true);
    assert.equal(findModel("openrouter",id.replace(/:free$/,"")),null);
  }
  for(const id of ["apodex/apodex-1.1-mini:free","inclusionai/ling-3.1-flash","google/lyria-3-pro-preview","google/lyria-3-clip-preview"])assert.equal(findModel("openrouter",id),null);
  assert.deepEqual(MODEL_CATALOG.filter(m=>m.provider==="tokenharbor").map(m=>m.id).sort(),["deepseek-v4.1-flash:free","mimo-v2.6-flash:free"]);
  for(const id of ["claude-haiku-5.5:free","claude-haiku-5.5","deepseek-v4.1-flash","mimo-v2.6-flash"])assert.equal(findModel("tokenharbor",id),null);
  assert.equal(findModel("gemini","gemini-4-argon"),null);
  assert.match(findModel("gemini","gemini-3.7-flash").note,/3.8 Flash/);
  assert.match(findModel("gemini","gemini-3.5-flash").note,/3.6 Flash/);
  for(const id of ["gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite"])assert.match(findModel("gemini",id).note,/既存利用者/);
});

test("saved removed provider and model recover to valid selections", () => {
  const source = html.match(/function renderModelControls\(\)\{[\s\S]*?\n\}/)[0];
  function element() { return { children: [], appendChild(child) { this.children.push(child); } }; }
  for (const saved of [
    { provider: "bai", model: "glm-5.3-flash" },
    { provider: "experientiallabs", model: "gpt-6-luna" },
    { provider: "openrouter", model: "stealth/space-bunny-alpha" },
    { provider: "openrouter", model: "apodex/apodex-1.1-mini:free" },
    { provider: "openrouter", model: "inclusionai/ling-3.1-flash" },
    { provider: "tokenharbor", model: "claude-haiku-5.5:free" },
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
