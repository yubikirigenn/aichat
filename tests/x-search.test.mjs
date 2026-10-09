import test from "node:test";
import assert from "node:assert/strict";
import { normalizeXSearch, createXSearcher } from "../x-search.mjs";

const access = { enabled: true, bearerToken: "private-token" };
const fixture = { data: [{ id: "123", text: "<script>untrusted</script>", author_id: "9", created_at: "2026-10-09T00:00:00Z", lang: "ja" }], includes: { users: [{ id: "9", username: "example", name: "Example" }] }, meta: { result_count: 1, next_token: "next" } };

test("X search validates keywords, result limits, sort and pagination", () => {
  assert.deepEqual(normalizeXSearch({ query: " from:example lang:ja -is:retweet " }), { query: "from:example lang:ja -is:retweet", max_results: 10, sort_order: "recency" });
  for (const body of [{}, { query: " " }, { query: "a".repeat(513) }, { query: "a", max_results: 100 }, { query: "a", sort_order: "bad" }, { query: "a", next_token: {} }]) assert.throws(() => normalizeXSearch(body));
});

test("X search stays disabled without both administrator opt-in and token", async () => {
  let calls = 0;
  const search = createXSearcher({ fetchImpl: async () => { calls++; } });
  for (const config of [{}, { enabled: true }, { bearerToken: "secret" }]) await assert.rejects(search({ query: "Gemini" }, config), /X_SEARCH_ENABLED/);
  assert.equal(calls, 0);
});

test("X search uses fixed official API, returns normalized posts and caches/deduplicates calls", async () => {
  let count = 0, clock = 0;
  const search = createXSearcher({ now: () => clock, fetchImpl: async (url, init) => {
    count++; const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.x.com"); assert.equal(parsed.pathname, "/2/tweets/search/recent");
    assert.equal(parsed.searchParams.get("query"), "Gemini lang:ja"); assert.equal(parsed.searchParams.get("max_results"), "10");
    assert.equal(init.headers.Authorization, "Bearer private-token"); assert.equal(init.redirect, "error");
    return Response.json(fixture);
  } });
  const [a, b] = await Promise.all([search({ query: "Gemini lang:ja" }, access), search({ query: "Gemini lang:ja" }, access)]);
  assert.equal(count, 1); assert.equal(a.results[0].url, "https://x.com/example/status/123");
  assert.equal(b.results[0].text, "<script>untrusted</script>"); assert.equal(a.next_token, "next");
  assert.doesNotMatch(JSON.stringify(a), /private-token/);
  assert.equal((await search({ query: "Gemini lang:ja" }, access)).cached, true);
  clock = 31000; await search({ query: "Gemini lang:ja", next_token: "next" }, access); assert.equal(count, 2);
});

test("X API failures do not retry or expose upstream bodies; partial and zero results are explicit", async () => {
  for (const status of [400, 401, 402, 403, 429, 503]) {
    let calls = 0;
    const search = createXSearcher({ fetchImpl: async () => { calls++; return new Response("private-token", { status }); } });
    await assert.rejects(search({ query: "Gemini" }, access), error => error.status === status && !error.message.includes("private-token"));
    assert.equal(calls, 1);
  }
  const empty = createXSearcher({ fetchImpl: async () => Response.json({ meta: { result_count: 0 } }) });
  assert.equal((await empty({ query: "none" }, access)).count, 0);
  const partial = createXSearcher({ fetchImpl: async () => Response.json({ ...fixture, errors: [{ detail: "private-token" }] }) });
  const result = await partial({ query: "Gemini" }, access);
  assert.equal(result.partial, true); assert.equal(result.count, 1); assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test("invalid and oversized X responses fail safely", async () => {
  for (const payload of [{}, { data: {} }, { text: "a".repeat(1000001) }]) {
    const search = createXSearcher({ fetchImpl: async () => Response.json(payload) });
    await assert.rejects(search({ query: "Gemini" }, access));
  }
});
