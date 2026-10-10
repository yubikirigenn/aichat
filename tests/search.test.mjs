import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeSearchOptions, buildSearchQuery, canonicalSearchUrl, rankSearchResults, runSearch, focusedSearchQuery } from "../search.mjs";

const result = (url, title = "Render Node deployment", snippet = "Node service configuration") => ({ url, title, snippet });
const options = body => normalizeSearchOptions(body, "Render Node");

test("filters validate types and produce combined query operators", () => {
  const filter = options({ include_domains: ["render.com", "nodejs.org"], exclude_domains: ["spam.com"], exact_phrases: ["Node 22"], exclude_terms: ["advertisement"], file_type: "pdf", time_range: "week", language: "ja", region: "JP" });
  assert.equal(buildSearchQuery("Render Node", filter), 'Render Node (site:render.com OR site:nodejs.org) -site:spam.com "Node 22" -"advertisement" filetype:pdf');
  for (const invalid of [{ include_domains: ["render.com OR spam.com"] }, { include_domains: "render.com" }, { time_range: "forever" }, { exact_phrases: ['a"b'] }, { language: "unknown" }]) {
    assert.throws(() => options(invalid));
  }
  assert.equal(normalizeSearchOptions({}, "東京 天気").language, "ja");
  assert.equal(normalizeSearchOptions({}, "Node deploy").language, "en");
});

test("canonical URLs remove tracking, fragments and parameter order duplicates", () => {
  assert.equal(canonicalSearchUrl("https://example.com/page?b=2&utm_source=a&a=1#section"), "https://example.com/page?a=1&b=2");
  assert.equal(canonicalSearchUrl("javascript:alert(1)"), null);
  assert.equal(canonicalSearchUrl("https://user:password@example.com"), null);
});

test("search words echoed in URL parameters do not make an unrelated page relevant", () => {
  const ranked = rankSearchResults([{ id: "bing", results: [result("https://cats.com/?q=Render+Node", "Cats", "Pet food")] }], "Render Node", options({}), 5);
  assert.equal(ranked.length, 0);
});

test("Liquid AI and Artificial Analysis searches reject the reported general-word false positives",()=>{
  const irrelevant=[
    result("https://www.drinkliquidplus.com/","Liquid Salad by Liquid+","Drink your daily vegetables in seconds"),
    result("https://en.wikipedia.org/wiki/Liquid","Liquid - Wikipedia","Liquid is one of the three states of matter"),
    result("https://www.liquid.trade/","Liquid Trading","Trading for stocks and crypto"),
    result("https://www.merriam-webster.com/dictionary/liquid","LIQUID Definition & Meaning","The meaning of liquid"),
    result("https://en.wikipedia.org/wiki/Artificial_intelligence","Artificial intelligence","Artificial intelligence is the capability of systems"),
    result("https://www.youtube.com/watch?v=1","ARTIFICIAL Official Trailer","Artificial movie trailer"),
    result("https://artificialanalysis.ai/","AI Model & API Providers Analysis | Artificial Analysis","AI model benchmarks"),
  ];
  for(const query of ["Liquid AI LFM latest model benchmark","Liquid AI LFM2 release","Artificial Analysis LFM2 Liquid AI intelligence index","Liquid AI LFM2.5 benchmark artificial analysis","LFM2-24B-A2B Artificial Analysis"]){
    assert.deepEqual(rankSearchResults([{id:"bing",results:irrelevant}],query,normalizeSearchOptions({},query),10),[],query);
  }
  const query="Liquid AI LFM latest model benchmark";
  const relevant=result("https://www.liquid.ai/blog/lfm2","Liquid AI LFM2 model benchmark","Latest LFM model performance and benchmarks");
  assert.equal(rankSearchResults([{id:"bing",results:[...irrelevant,relevant]}],query,normalizeSearchOptions({},query),5)[0].url,relevant.url);
});

test("model ID anchors survive display punctuation without accepting a different ID",()=>{
  const query="LFM2-24B-A2B Artificial Analysis";
  const items=[result("https://example.com/wrong","LFM2 8B A1B Artificial Analysis","Model benchmark"),result("https://example.com/right","LFM2 24B A2B Artificial Analysis","Model benchmark")];
  assert.deepEqual(rankSearchResults([{id:"bing",results:items}],query,normalizeSearchOptions({},query),5).map(r=>r.url),["https://example.com/right"]);
});

test("an irrelevant backend batch gets one focused retrieval, preserving explicit filters",async()=>{
  const query="Liquid AI LFM2 release",filter=normalizeSearchOptions({include_domains:["liquid.ai"],time_range:"month"},query),sent=[];
  const focused=focusedSearchQuery(query,filter);
  assert.equal(focused,'Liquid AI "LFM2" release (site:liquid.ai)');
  const response=await runSearch([{id:"bing",run:async(q,_max,opts)=>{
    sent.push(q);assert.equal(opts.time_range,"month");
    return q===focused?[result("https://liquid.ai/lfm2","Liquid AI LFM2 release","New model")]:[result("https://liquid.ai/other","Liquid AI","Company homepage")];
  }}],query,5,filter);
  assert.deepEqual(sent,[buildSearchQuery(query,filter),focused]);assert.equal(response.results.length,1);assert.equal(response.backend_timings[0].attempts,2);
  assert.equal(focusedSearchQuery('Liquid AI "LFM2"',filter),null);
});

test("failed focused retrieval stays bounded and never presents irrelevant candidates as success",async()=>{
  let calls=0;
  const response=await runSearch([{id:"bing",run:async()=>{calls++;return [result("https://en.wikipedia.org/wiki/Liquid","Liquid","Liquid AI trading daily")];}}],"Liquid AI LFM2 release",5,options({}));
  assert.equal(calls,2);assert.equal(response.results.length,0);assert.equal(response.code,"no_relevant_results");assert.equal(response.backend_timings[0].status,"irrelevant");
});

test("fast generic-word results do not cancel a slower relevant search engine",async()=>{
  const query="Liquid AI LFM2 release";
  const response=await runSearch([
    {id:"bing",run:async()=>[result("https://en.wikipedia.org/wiki/Liquid","Liquid","Liquid AI daily trading release")]},
    {id:"ddg",run:async()=>{await new Promise(r=>setTimeout(r,20));return [result("https://liquid.ai/lfm2","Liquid AI LFM2 release","Official model")];}},
  ],query,5,normalizeSearchOptions({},query),{settleMs:1,deadlineMs:200,hedgeMs:100});
  assert.equal(response.results[0].url,"https://liquid.ai/lfm2");assert.equal(response.provider,"ddg");
  assert.equal(response.backend_timings.find(t=>t.provider==="bing").status,"irrelevant");
});

test("rank merges engines, removes unrelated hits and enforces domain boundaries", () => {
  const ranked = rankSearchResults([
    { id: "bing", results: [result("https://news.com/cats", "Cats and dogs", "Pet food"), result("https://docs.render.com/node?utm_source=test"), result("https://render.com.evil.com/node"), result("https://spam.render.com/node")] },
    { id: "ddg", results: [result("https://docs.render.com/node#top")] },
  ], "Render Node", options({ include_domains: ["render.com"], exclude_domains: ["spam.render.com"] }), 5);
  assert.equal(ranked.length, 1);
  assert.deepEqual(ranked[0].sources, ["bing", "ddg"]);
});

test("file type, exclusion terms and same-host diversity are respected", () => {
  const items = [result("https://docs.com/a.pdf"), result("https://docs.com/b.pdf"), result("https://docs.com/c.pdf"), result("https://other.com/a.pdf"), result("https://other.com/b.pdf", "Render advertisement"), result("https://other.com/a.html")];
  const ranked = rankSearchResults([{ id: "bing", results: items }], "Render", options({ file_type: "pdf", exclude_terms: ["advertisement"] }), 4);
  assert.deepEqual(ranked.map(r => r.url), ["https://docs.com/a.pdf", "https://docs.com/b.pdf", "https://other.com/a.pdf", "https://docs.com/c.pdf"]);
  assert.doesNotThrow(() => rankSearchResults([{ id: "bing", results: [result("https://docs.com/%xx")] }], "Render", options({}), 5));
});

test("primary search engines start in parallel, without unnecessary fallback", async () => {
  const started = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const backends = ["bing", "ddg"].map(id => ({ id, run: async () => { started.push(id); if (started.length === 2) release(); await gate; return [result(`https://${id}.com/node`)]; } }));
  backends.push({ id: "lite", run: () => { throw new Error("must not run"); } });
  const response = await runSearch(backends, "Render Node", 5, options({}));
  assert.deepEqual(started, ["bing", "ddg"]);
  assert.equal(response.results.length, 2);
  assert.deepEqual(response.errors, []);
});

test("irrelevant/failed first engines trigger fallback; zero matches return recovery guidance", async () => {
  const backends = [
    { id: "bing", run: async () => [result("https://cats.com", "Cats", "Pets")] },
    { id: "ddg", run: async () => { throw new Error("challenge"); } },
    { id: "lite", run: async () => [result("https://render.com/node")] },
  ];
  assert.equal((await runSearch(backends, "Render Node", 5, options({}))).results.length, 1);
  const zero = await runSearch(backends, "Render Node", 5, options({ include_domains: ["example.com"] }));
  assert.equal(zero.results.length, 0); assert.ok(zero.recovery_hint);
  await assert.rejects(runSearch([{ id: "down", run: async () => { throw new Error("down"); } }], "Render", 5, options({})), /All search backends failed/);
});

// Exercise existing HTML parsers with fixtures, without starting a server.
test("transient backend failures recover once within the same search deadline",async()=>{
  let calls=0;
  const response=await runSearch([{id:"engine",run:async()=>{
    if(++calls===1)throw Object.assign(new Error("HTTP 503"),{upstream_status:503});
    return [result("https://render.com/node")];
  }}],"Render",5,options({}));
  assert.equal(calls,2);assert.equal(response.results.length,1);assert.equal(response.backend_timings[0].attempts,2);
});
test("batch search retains backend failure status without misclassifying permanent errors",async()=>{
  const {runSearchBatch}=await import("../search.mjs");
  const response=await runSearchBatch(["Render"],q=>runSearch([{id:"engine",run:async()=>{throw Object.assign(new Error("HTTP 403"),{upstream_status:403})}}],q,5,options({})));
  assert.equal(response.searches[0].retryable,false);
  assert.equal(response.searches[0].backend_failures[0].upstream_status,403);
  assert.match(response.searches[0].details[0],/403/);
});
test("useful fast results return without waiting for stalled engines, cancelling losers", async () => {
  let slowSignal, fallbackRan = false;
  const response = await runSearch([
    { id: "fast", run: async () => [result("https://render.com/node")] },
    { id: "slow", run: (_q, _n, _o, signal) => { slowSignal = signal; return new Promise(() => {}); } },
    { id: "lite", run: async () => { fallbackRan = true; return []; } },
  ], "Render Node", 5, options({}), { settleMs: 5, hedgeMs: 100, deadlineMs: 200 });
  assert.equal(response.results.length, 1); assert.equal(response.partial, true);
  assert.equal(response.deadline_reached, false); assert.equal(slowSignal.aborted, true);
  assert.equal(fallbackRan, false); assert.equal(response.backend_timings[0].provider, "fast");
  assert.deepEqual(response.errors, []);
});

test("fallback starts before stuck primary engines finish", async () => {
  const signals = [];
  const stuck = id => ({ id, run: (_q, _n, _o, signal) => { signals.push(signal); return new Promise(() => {}); } });
  const response = await runSearch([stuck("bing"), stuck("ddg"), { id: "lite", run: async () => [result("https://render.com/node")] }],
    "Render Node", 5, options({}), { hedgeMs: 5, settleMs: 5, deadlineMs: 200 });
  assert.equal(response.provider, "lite"); assert.equal(response.results.length, 1);
  assert.equal(response.deadline_reached, false); assert.ok(signals.every(signal => signal.aborted));
});

test("one total deadline bounds stalled searches and preserves completed empty results", async () => {
  const stuck = { id: "stuck", run: () => new Promise(() => {}) };
  const response = await runSearch([{ id: "empty", run: async () => [] }, stuck], "Render", 5, options({}), { deadlineMs: 10, hedgeMs: 2 });
  assert.equal(response.deadline_reached, true); assert.equal(response.results.length, 0);
  assert.ok(response.recovery_hint); assert.ok(response.errors.some(message => message.includes("時間上限")));
  await assert.rejects(runSearch([stuck], "Render", 5, options({}), { deadlineMs: 10, hedgeMs: 2 }), /All search backends failed/);
});

const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
function helpers(names) {
  const source = names.map(name => {
    const start = server.indexOf(`function ${name}(`);
    const next = server.slice(start + 1).search(/\n(?:async )?function |\nconst SEARCH_BACKENDS/);
    return server.slice(start, start + 1 + next);
  }).join("\n");
  return runInNewContext(source + "\n({" + names.join(",") + "})", { URL, URLSearchParams, Buffer });
}

test("DuckDuckGo parsers handle href before class and preserve encoded URLs", () => {
  const h = helpers(["decodeHtmlEntities", "stripHtml", "isJunkSearchUrl", "pushUniqueResult", "decodeDdgUrl", "parseDdgHtml", "parseDdgLiteHtml"]);
  const html = '<div class="result results_links"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frender.com%2Fa%253Fb" class="result__a">Render</a><a class="result__snippet">Node docs</a></div>';
  assert.equal(h.parseDdgHtml(html, 5)[0].url, "https://render.com/a%3Fb");
  const lite = '<a href="https://render.com/node" class="result-link">Render Node</a><td class="result-snippet">Deploy Node</td>';
  assert.equal(h.parseDdgLiteHtml(lite, 5)[0].snippet, "Deploy Node");
});

test("region mappings and recency options use valid DuckDuckGo locale IDs", () => {
  const h = helpers(["searchLocale", "ddgSearchParams"]);
  assert.equal(h.ddgSearchParams("東京", options({ language: "ja", region: "JP", time_range: "week" })).get("kl"), "jp-jp");
  assert.equal(h.ddgSearchParams("Node", options({ region: "GB", time_range: "week" })).get("kl"), "uk-en");
  assert.equal(h.ddgSearchParams("Node", options({ time_range: "week" })).get("df"), "w");
});
