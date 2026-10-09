import test from "node:test";
import assert from "node:assert/strict";
import { createXPostReader, parseXPostUrl, normalizeXPost } from "../x-post.mjs";

const tweet = { id: "20", text: "public <post>", created_at: "date", author: { name: "Jack", screen_name: "jack" }, media: { photos: [{ type: "photo", url: "https://pbs.twimg.com/test.jpg", alt_text: "test" }, { url: "javascript:bad" }] }, quote: { id: "21", text: "quote", author: { screen_name: "other" } } };
test("X post URLs normalize safely without arbitrary upstream URLs", () => {
  for (const url of ["https://x.com/jack/status/20?s=1", "https://twitter.com/i/web/status/20", "https://mobile.twitter.com/jack/status/20/photo/1"]) assert.equal(parseXPostUrl(url).id, "20");
  for (const url of ["https://x.com.evil.test/jack/status/20", "https://evil.test/status/20", "https://x.com/jack", "https://u:p@x.com/jack/status/20", "https://x.com:3000/jack/status/20", "file:///jack/status/20"]) assert.throws(() => parseXPostUrl(url));
});
test("normalization keeps text, quote and safe media but no arbitrary raw payload", () => {
  const post = normalizeXPost(tweet, "20");
  assert.equal(post.text, "public <post>");assert.equal(post.media.length, 1);assert.equal(post.quote.text, "quote");assert.equal(post.likes, null);
  assert.equal(post.url, "https://x.com/jack/status/20");assert.equal(post.quote.quote, null);
  assert.equal(normalizeXPost({ ...tweet, quote: { id: "21" } }, "20").quote, null);
});
test("reader retries transient failure, caches successes and uses a fixed endpoint", async () => {
  let calls = 0, clock = 100000;
  const read = createXPostReader({ now: () => clock, retryDelay: async () => {}, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.fxtwitter.com/status/20");assert.equal(options.redirect, "error");assert.equal(options.headers.Authorization, undefined);
    if (++calls === 1) return new Response("bad", { status: 503 });
    return Response.json({ code: 200, tweet });
  } });
  assert.equal((await read("https://x.com/jack/status/20")).cached, false);
  assert.equal((await read("https://twitter.com/jack/status/20")).cached, true);assert.equal(calls, 2);
  clock += 61000;await read("https://x.com/jack/status/20");assert.equal(calls, 3);
});
test("missing and private posts do not return invented data or retry", async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const read = createXPostReader({ fetchImpl: async () => { calls++;return new Response("", { status }); } });
    await assert.rejects(read("https://x.com/jack/status/20"), /非公開/);assert.equal(calls, 1);
  }
});
test("invalid, oversized and mismatched upstream data is rejected", async () => {
  for (const response of [Response.json({ code: 200, tweet: { ...tweet, id: "22" } }), new Response("a".repeat(1000001))]) {
    let calls = 0;
    const read = createXPostReader({ fetchImpl: async () => { calls++;return response; } });
    await assert.rejects(read("https://x.com/jack/status/20"));assert.equal(calls, 1);
  }
});
