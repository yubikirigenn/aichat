// Local search policy: provider rank is retained; lexical overlap only removes
// obvious mismatches. It is not semantic verification of the page's contents.
export function normalizeSearchQueries(body = {}) {
  if (body.query !== undefined && body.queries !== undefined) throw new Error("queryとqueriesはどちらか一方を指定してください。");
  const values = body.queries === undefined ? [body.query] : body.queries;
  if (!Array.isArray(values) || !values.length || values.length > 6 || values.some(q => typeof q !== "string" || !q.trim() || q.length > 500)) throw new Error("query（1〜500文字）またはqueries（最大6件の検索語）を指定してください。");
  return [...new Set(values.map(q => q.trim()))];
}

export async function runSearchBatch(queries, search, concurrency = 3) {
  const searches = new Array(queries.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, async () => {
    for (;;) {
      const index = cursor++; if (index >= queries.length) return;
      const query = queries[index];
      try { const { errors = [], ...result } = await search(query); searches[index] = { query, ok: true, ...result, warnings: errors }; }
      catch { searches[index] = { query, ok: false, results: [], error: "検索先で失敗しました。このクエリだけ修正・再試行してください。" }; }
    }
  }));
  const merged = new Map();
  for (const item of searches) for (const result of item.results) {
    const key = canonicalSearchUrl(result.url); if (!key) continue;
    if (merged.has(key)) merged.get(key).matched_queries.push(item.query);
    else merged.set(key, { ...result, matched_queries: [item.query] });
  }
  const results = [...merged.values()];
  // Snippets live once in the merged list, instead of duplicating large tool data.
  const summaries = searches.map(({ results, ...rest }) => ({ ...rest, results: results.map(({ url, title }) => ({ url, title })) }));
  return { ok: searches.some(s => s.ok), queries, searches: summaries, results, count: results.length,
    warnings: searches.flatMap(s => s.warnings || [s.error]).filter(Boolean),
    ...(searches.some(s => !s.ok || !s.results.length) ? { recovery_hint: "成功したクエリの結果を利用し、失敗・0件のクエリだけ修正して再検索してください。" } : {}) };
}

export function normalizeSearchOptions(body = {}, query = "") {
  const list = (key, validate = () => true) => {
    if (body[key] === undefined) return [];
    if (!Array.isArray(body[key]) || body[key].length > 8) throw new Error(`${key}: expected up to 8 values`);
    return [...new Set(body[key].map(value => {
      if (typeof value !== "string" || !value.trim() || value.length > 120 || !validate(value.trim())) throw new Error(`Invalid ${key}`);
      return value.trim();
    }))];
  };
  const domain = value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
  const choose = (key, allowed, fallback) => {
    const value = body[key] ?? fallback;
    if (!allowed.includes(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const language = choose("language", ["auto", "ja", "en"], "auto");
  const detected = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(query) ? "ja" : "en";
  return {
    include_domains: list("include_domains", domain).map(v => v.toLowerCase()),
    exclude_domains: list("exclude_domains", domain).map(v => v.toLowerCase()),
    exact_phrases: list("exact_phrases", v => !/["\r\n]/.test(v)),
    exclude_terms: list("exclude_terms", v => !/["\r\n]/.test(v)),
    file_type: choose("file_type", ["any", "pdf", "docx", "xlsx", "pptx", "txt"], "any"),
    time_range: choose("time_range", ["any", "day", "week", "month", "year"], "any"),
    language: language === "auto" ? detected : language,
    region: choose("region", ["auto", "JP", "US", "GB", "DE", "FR", "CA", "AU"], "auto"),
  };
}

export function buildSearchQuery(query, options) {
  const parts = [query];
  if (options.include_domains.length) parts.push(`(${options.include_domains.map(d => `site:${d}`).join(" OR ")})`);
  parts.push(...options.exclude_domains.map(d => `-site:${d}`));
  parts.push(...options.exact_phrases.map(p => `"${p}"`));
  parts.push(...options.exclude_terms.map(p => `-"${p}"`));
  if (options.file_type !== "any") parts.push(`filetype:${options.file_type}`);
  return parts.join(" ");
}

export function canonicalSearchUrl(raw) {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

const stopWords = new Set("the a an and or of in on to for is are what how with from latest official please search find about 現在 最新 について 調べて ください 検索 方法 とは の を が は で と に です ます".split(" "));
function queryTerms(query) {
  const plain = query.replace(/-?(?:site|filetype|intitle|inurl):\S+/gi, " ").normalize("NFKC").toLowerCase();
  const segments = [...new Intl.Segmenter("ja", { granularity: "word" }).segment(plain)];
  return [...new Set(segments.filter(s => s.isWordLike).map(s => s.segment).filter(s => s.length > 1 && !stopWords.has(s)))];
}

export function rankSearchResults(batches, query, options, maxResults) {
  const terms = queryTerms(query);
  const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  const merged = new Map();
  for (const batch of batches) for (const [index, item] of batch.results.entries()) {
    const url = canonicalSearchUrl(item.url);
    if (!url) continue;
    const parsed = new URL(url), host = parsed.hostname.toLowerCase();
    if (options.include_domains.length && !options.include_domains.some(d => matchesDomain(host, d))) continue;
    if (options.exclude_domains.some(d => matchesDomain(host, d))) continue;
    if (options.file_type !== "any" && !parsed.pathname.toLowerCase().endsWith(`.${options.file_type}`)) continue;
    const title = String(item.title || "").normalize("NFKC").toLowerCase();
    // Query parameters can echo the search terms on unrelated pages. Do not
    // treat those as evidence of relevance.
    let readableUrl = `${parsed.hostname}${parsed.pathname}`;
    try { readableUrl = decodeURI(readableUrl); } catch { /* Keep malformed escapes as-is. */ }
    const text = `${title} ${item.snippet || ""} ${readableUrl}`.normalize("NFKC").toLowerCase();
    if (options.exclude_terms.some(term => text.includes(term.normalize("NFKC").toLowerCase()))) continue;
    const hits = terms.filter(term => text.includes(term)).length;
    const coverage = terms.length ? hits / terms.length : 1;
    if (terms.length && (hits === 0 || coverage < 0.25)) continue;
    const key = url.replace(/^https?:\/\/(www\.)?/, "");
    const score = coverage * 2 + terms.filter(term => title.includes(term)).length / Math.max(1, terms.length) + 1 / (index + 1);
    const existing = merged.get(key);
    if (existing) {
      if (!existing.sources.includes(batch.id)) { existing.sources.push(batch.id); existing.score += 0.4; }
      if (String(item.snippet || "").length > existing.snippet.length) existing.snippet = String(item.snippet).slice(0, 500);
    } else merged.set(key, { title: String(item.title || url).slice(0, 200), url, snippet: String(item.snippet || "").slice(0, 500), sources: [batch.id], score });
  }
  // Avoid one site filling the entire first page; keep remaining same-site hits
  // afterwards, so single-site searches do not silently lose useful results.
  const sorted = [...merged.values()].sort((a, b) => b.score - a.score);
  const counts = new Map(), first = [], rest = [];
  for (const result of sorted) {
    const host = new URL(result.url).hostname.replace(/^www\./, "");
    const count = counts.get(host) || 0; counts.set(host, count + 1);
    (count < 2 ? first : rest).push(result);
  }
  return [...first, ...rest].slice(0, maxResults).map(({ score: _score, ...result }) => result);
}

export async function runSearch(backends, query, maxResults, options, policy = {}) {
  const batches = [], errors = [];
  const searchQuery = buildSearchQuery(query, options);
  const started = performance.now(), controller = new AbortController();
  const timings = [], timers = [];
  let closed = false, pending = 0, primaryPending = 0, fallbackStarted = false, settling = false;
  let deadlineReached = false, unfinished = 0;
  await new Promise(resolve => {
    const finish = () => {
      if (closed) return;
      closed = true; unfinished = pending;
      timers.forEach(clearTimeout); controller.abort(); resolve();
    };
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const launchFallback = () => {
      if (closed || fallbackStarted) return;
      fallbackStarted = true;
      launch(backends.slice(2), false);
    };
    const check = () => {
      if (closed) return;
      const useful = rankSearchResults(batches, query, options, maxResults).length;
      if (useful && !settling) {
        settling = true;
        // Merge near-simultaneous results, without waiting for a stalled engine.
        later(finish, policy.settleMs ?? 200);
      }
      if (!useful && primaryPending === 0) launchFallback();
      if (!pending) finish();
    };
    const launch = (group, primary) => {
      pending += group.length;
      if (primary) primaryPending += group.length;
      for (const backend of group) {
        const at = performance.now();
        Promise.resolve().then(() => backend.run(searchQuery, Math.min(20, maxResults * 3), options, controller.signal)).then(value => {
          if (closed) return;
          batches.push({ id: backend.id, results: value });
          if (!value.length) errors.push(`${backend.id}: 0 results`);
          timings.push({ provider: backend.id, elapsed_ms: Math.round(performance.now() - at), status: value.length ? "ok" : "empty" });
        }, error => {
          if (closed) return;
          errors.push(`${backend.id}: ${error?.message || "failed"}`);
          timings.push({ provider: backend.id, elapsed_ms: Math.round(performance.now() - at), status: "failed" });
        }).finally(() => {
          if (closed) return;
          pending--; if (primary) primaryPending--;
          check();
        });
      }
    };
    later(() => { deadlineReached = true; finish(); }, policy.deadlineMs ?? 6500);
    later(() => { if (!settling) launchFallback(); }, policy.hedgeMs ?? 1000);
    launch(backends.slice(0, 2), true);
    check();
  });
  const results = rankSearchResults(batches, query, options, maxResults);
  if (deadlineReached) errors.push("検索の時間上限に達しました。取得済みの結果を返します。");
  if (!batches.length) { const error = new Error("All search backends failed"); error.details = errors; throw error; }
  return {
    results, provider: batches.filter(b => b.results.length).map(b => b.id).join("+") || "none",
    elapsed_ms: Math.round(performance.now() - started), backend_timings: timings,
    partial: unfinished > 0, deadline_reached: deadlineReached,
    errors, search_query: searchQuery, filters: options,
    filter_notes: ["言語・地域は検索先への優先指定です。期間は検索先のインデックス基準で、公開日を保証しません。", "関連性はタイトル・抜粋・URLの語句一致による補助判定です。本文の確認にはweb_fetchを使ってください。"],
    ...(results.length ? {} : { recovery_hint: "条件に合う結果がありません。主要語を短く言い換えるか、ユーザーの必須条件を維持したまま任意の絞り込みを見直してください。" }),
  };
}
