import { buildSearchQuery, rankSearchResults } from "./search.mjs";

const countries = { JP: "japan", US: "united states", GB: "united kingdom", DE: "germany", FR: "france", CA: "canada", AU: "australia" };
function failure(code, message, status = 502, extra = {}) {
  return Object.assign(new Error(message), { code, status, searchSafe: true, retryable: false, ...extra });
}

// Only Basic search is allowed. Confirmation is an operator assertion, not a
// billing-state check. Never retry a request that might have consumed credits.
export function createTavilySearcher({ fetchImpl = fetch, now = Date.now, timeoutMs = 8000 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function searchTavily(query, maxResults, options, { apiKey, freeTierConfirmed } = {}) {
    if (!apiKey) throw failure("tavily_not_configured", "TavilyのAPIキーが未設定です。", 503);
    if (freeTierConfirmed !== true) throw failure("tavily_free_unconfirmed", "Tavilyの無料プランと従量課金OFFを確認し、TAVILY_FREE_TIER_CONFIRMED=trueを設定してください。", 503);
    const searchQuery = buildSearchQuery(query, { ...options, include_domains: [], exclude_domains: [] });
    const payload = {
      query: searchQuery, search_depth: "basic", auto_parameters: false, topic: "general",
      max_results: Math.max(1, Math.min(10, Math.floor(maxResults) || 5)),
      include_answer: false, include_raw_content: false, include_images: false, include_usage: true,
      include_domains: options.include_domains, exclude_domains: options.exclude_domains,
      ...(options.include_domains.length ? { include_domains_mode: "restrict" } : {}),
      language: options.language, filter_by_language: false,
      ...(options.time_range !== "any" ? { time_range: options.time_range } : {}),
      ...(countries[options.region] ? { country: countries[options.region] } : {}),
    };
    // Private in-memory key: credentials never appear in logs or tool output.
    const key = JSON.stringify([apiKey, payload]);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return { ...cached.result, cached: true, credits_consumed: 0, elapsed_ms: 0, backend_timings: [] };
    if (pending.has(key)) return { ...await pending.get(key), coalesced: true, credits_consumed: 0 };
    const task = (async () => {
      const started = now(), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl("https://api.tavily.com/search", {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const status = response.status;
          const action = status === 401 ? "RenderのTAVILY_API_KEYを確認してください。" : [432, 433].includes(status) ? "Tavilyの利用枠を確認し、リセットを待ってください。従量課金を有効にしないでください。" : status === 429 ? "時間を置いてから再実行してください。" : "Tavilyの稼働状態を確認してください。";
          throw failure(`tavily_http_${status}`, `Tavily検索に失敗しました（HTTP ${status}）。${action}`, status === 401 || [432, 433].includes(status) ? 503 : 502, { upstream_status: status, next_action: action, retryable: status === 429 || status >= 500 });
        }
        if (Number(response.headers.get("content-length")) > 2_000_000) {
          await response.body?.cancel();
          throw failure("tavily_response_too_large", "Tavilyの応答がサイズ上限を超えました。");
        }
        const reader = response.body?.getReader();
        if (!reader) throw failure("tavily_invalid_response", "Tavilyの応答が空です。");
        const chunks = []; let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw failure("tavily_response_too_large", "Tavilyの応答がサイズ上限を超えました。"); }
          chunks.push(Buffer.from(value));
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("tavily_invalid_response", "Tavilyの応答を解析できませんでした。"); }
        if (!Array.isArray(data.results)) throw failure("tavily_invalid_response", "Tavilyの検索結果形式が不正です。");
        const results = rankSearchResults([{ id: "tavily", results: data.results.filter(item => item && typeof item === "object").map(item => ({ title: item.title, url: item.url, snippet: item.content })) }], query, options, payload.max_results, { providerRank: true });
        const elapsed_ms = now() - started;
        const result = { results, provider: "tavily", errors: [], cached: false, elapsed_ms,
          credits_consumed: Number.isFinite(data.usage?.credits) ? data.usage.credits : null,
          backend_timings: [{ provider: "tavily", attempts: 1, elapsed_ms, status: results.length ? "ok" : "empty" }],
          filters: options, search_query: searchQuery,
          ...(!results.length ? { recovery_hint: "条件に合う結果がありません。対象が存在しないとは断定せず、必須条件を維持して検索語を見直してください。" } : {}) };
        for (const [entryKey, entry] of cache) if (entry.expires <= now()) cache.delete(entryKey);
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(key, { expires: now() + 60_000, result });
        return result;
      } catch (error) {
        if (error.searchSafe) throw error;
        throw failure(controller.signal.aborted ? "tavily_timeout" : "tavily_connection_failed", controller.signal.aborted ? "Tavily検索が時間上限に達しました。" : "Tavilyへの接続に失敗しました。", 502, { retryable: true, next_action: "時間を置いて再実行してください。同じ要求を連続送信しないでください。" });
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
