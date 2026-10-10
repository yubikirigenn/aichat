import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createTavilySearcher } from "../tavily-search.mjs";
import { normalizeSearchOptions, runSearchBatch } from "../search.mjs";

const credentials = { apiKey: "tvly-test-secret", freeTierConfirmed: true };
const options = normalizeSearchOptions({}, "Liquid AI LFM");
const response = () => Response.json({ results: [
  { title: "Model evaluation", url: "https://artificialanalysis.ai/models/lfm?utm_source=test", content: "Benchmark results" },
  { title: "Models", url: "https://www.liquid.ai/models", content: "Our small models" },
], usage: { credits: 1 }, answer: "do not forward" });

test("Tavily fails closed without key or explicit free confirmation", async () => {
  let calls = 0;
  const search = createTavilySearcher({ fetchImpl: async () => { calls++; return response(); } });
  for (const auth of [{}, { apiKey: credentials.apiKey }, { ...credentials, freeTierConfirmed: "true" }]) {
    await assert.rejects(search("Liquid AI", 5, options, auth), e => e.status === 503);
  }
  assert.equal(calls, 0);
});
test("fixed Basic request, provider ordering and safe domain filtering", async () => {
  let payload, request;
  const search = createTavilySearcher({ fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.tavily.com/search"); request = init; payload = JSON.parse(init.body); return response();
  } });
  const result = await search("Liquid AI LFM latest benchmark", 5, options, credentials);
  assert.equal(payload.search_depth, "basic"); assert.equal(payload.auto_parameters, false);
  assert.equal(payload.include_answer, false); assert.equal(payload.include_raw_content, false);
  assert.equal(payload.include_domains_mode, undefined); assert.equal(request.redirect, "error");
  assert.equal(request.headers.Authorization, "Bearer tvly-test-secret");
  // Semantic result without enough literal query words survives; API rank is retained.
  assert.equal(result.results[0].url, "https://artificialanalysis.ai/models/lfm");
  assert.equal(result.results.length, 2); assert.equal(result.credits_consumed, 1);
  assert.doesNotMatch(JSON.stringify(result), /tvly-|do not forward/);
  const filters = normalizeSearchOptions({ include_domains: ["liquid.ai"], exclude_domains: ["bad.liquid.ai"], exact_phrases: ["small models"], exclude_terms: ["food"], time_range: "week", region: "JP", language: "ja" });
  const filtered = await search("LFM", 5, filters, credentials);
  assert.equal(filtered.results.length, 1); assert.equal(payload.include_domains_mode, "restrict");
  assert.deepEqual(payload.include_domains, ["liquid.ai"]); assert.equal(payload.country, "japan");
  assert.equal(payload.language, "ja"); assert.equal(payload.time_range, "week");
  assert.match(payload.query, /"small models" -"food"/); assert.doesNotMatch(payload.query, /site:/);
});
test("unsafe URLs, excluded domains and file types are filtered without lexical gating", async () => {
  const search = createTavilySearcher({ fetchImpl: async () => Response.json({ results: [
    { url: "javascript:alert(1)" }, { url: "https://user:pass@liquid.ai/a.pdf" },
    { url: "https://bad.liquid.ai/a.pdf" }, { url: "https://liquid.ai/models" },
    { url: "https://liquid.ai/a.pdf", title: "Model card", content: "technical report" },
  ] }) });
  const filters = normalizeSearchOptions({ include_domains: ["liquid.ai"], exclude_domains: ["bad.liquid.ai"], file_type: "pdf" });
  const result = await search("LFM2 benchmark", 5, filters, credentials);
  assert.deepEqual(result.results.map(r => r.url), ["https://liquid.ai/a.pdf"]);
});
test("successful cache, credential/filter boundaries, expiry and coalescing", async () => {
  let calls = 0, time = 100;
  const search = createTavilySearcher({ now: () => time, fetchImpl: async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return response(); } });
  const first = await Promise.all([search("LFM", 5, options, credentials), search("LFM", 5, options, credentials)]);
  assert.equal(calls, 1); assert.equal(first[1].coalesced, true); assert.equal(first[1].credits_consumed, 0);
  const hit = await search("LFM", 5, options, credentials); assert.equal(hit.cached, true); assert.equal(hit.credits_consumed, 0);
  await assert.rejects(search("LFM", 5, options, { ...credentials, freeTierConfirmed: false }));
  await search("LFM", 5, options, { ...credentials, apiKey: "tvly-other" });
  await search("LFM", 5, { ...options, time_range: "week" }, credentials);
  await search("LFM", 3, options, credentials); assert.equal(calls, 4);
  time += 60_001; await search("LFM", 5, options, credentials); assert.equal(calls, 5);
});
test("HTTP failures never retry, expose raw bodies or mask quota errors in batches", async () => {
  for (const status of [400, 401, 429, 432, 433, 500]) {
    let calls = 0;
    const search = createTavilySearcher({ fetchImpl: async () => { calls++; return new Response("tvly-test-secret upstream private", { status }); } });
    await assert.rejects(search("LFM", 5, options, credentials), e => {
      assert.equal(e.code, `tavily_http_${status}`); assert.equal(e.upstream_status, status);
      assert.doesNotMatch(e.message, /secret|private/); return true;
    });
    assert.equal(calls, 1);
    const batch = await runSearchBatch(["LFM"], q => search(q, 5, options, credentials));
    assert.equal(batch.ok, false); assert.equal(batch.searches[0].code, `tavily_http_${status}`);
    assert.ok(batch.searches[0].next_action); assert.equal(calls, 2); // failures not cached
  }
});
test("malformed, oversized and timed out responses return bounded safe errors", async () => {
  for (const make of [() => new Response("not JSON"), () => Response.json({ answer: "no results" }),
    () => new Response("{}", { headers: { "content-length": "2000001" } }),
    () => new Response("x".repeat(2_000_001))]) {
    await assert.rejects(createTavilySearcher({ fetchImpl: async () => make() })("LFM", 5, options, credentials), e => e.searchSafe === true);
  }
  const search = createTavilySearcher({ timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("private network details")))) });
  await assert.rejects(search("LFM", 5, options, credentials), e => e.code === "tavily_timeout" && !e.message.includes("private"));
});
test("Tavily batch retains three-way parallelism", async () => {
  let active = 0, peak = 0;
  const search = createTavilySearcher({ fetchImpl: async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return response();
  } });
  const result = await runSearchBatch(["a", "b", "c", "d", "e", "f"], q => search(q, 5, options, credentials));
  assert.equal(peak, 3); assert.equal(result.searches.length, 6); assert.equal(result.count, 2);
});
test("server uses Tavily exclusively when configured; unset key permits explicit legacy warning", async () => {
  const source = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const env = {}; let legacy = 0, tavily = 0;
  const search = runInNewContext(source.slice(source.indexOf("async function searchWeb("), source.indexOf('app.disable("x-powered-by")')) + ";searchWeb", {
    process: { env }, normalizeApiKey: v => String(v || "").trim(), SEARCH_BACKENDS: [],
    runSearch: async () => { legacy++; return { errors: [] }; },
    searchTavily: async (_q, _max, _opts, auth) => { tavily++; assert.equal(auth.apiKey, "tvly-test"); if (!auth.freeTierConfirmed) throw new Error("confirmation required"); return { provider: "tavily" }; },
  });
  const old = await search("LFM", 5, options); assert.match(old.errors[0], /Tavily未設定/);
  env.TAVILY_API_KEY = "tvly-test";
  await assert.rejects(search("LFM", 5, options), /confirmation required/); assert.equal(legacy, 1);
  env.TAVILY_FREE_TIER_CONFIRMED = "true";
  assert.equal((await search("LFM", 5, options)).provider, "tavily"); assert.equal(tavily, 2);
});
