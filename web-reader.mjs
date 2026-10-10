export function webFailure(error) {
  const status = Number(error?.upstream_status || 0), cause = String(error?.cause?.code || error?.network_code || "");
  const timeout = ["AbortError", "TimeoutError"].includes(error?.name);
  const retryable = timeout || [408, 425, 429, 500, 502, 503, 504].includes(status) || /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(cause);
  return { code: timeout ? "web_fetch_timeout" : status ? "web_fetch_http" : "web_fetch_network", upstream_status: status || undefined, network_code: cause || undefined, retryable,
    next_action: retryable ? "一時障害です。再試行済みなら時間を置くか別の公式ページを使ってください。" : "URL・HTTP状態・接続制限を確認してください。認証やアクセス制限を回避せず別の公開一次情報を使ってください。" };
}
export function webPageByteLimit(value = process.env.WEB_FETCH_MAX_BYTES) {
  if (value === undefined || value === "") return 20_000_000;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000_000) throw new Error("WEB_FETCH_MAX_BYTESは1〜100000000の整数で設定してください。");
  return limit;
}
export async function readWebPage(url, { fetchImpl = fetch, validateUrl = () => {}, timeoutMs = 10000, retryDelay = () => new Promise(resolve => setTimeout(resolve, 250)), headers = {}, maxBytes = webPageByteLimit() } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100_000_000) throw new Error("取得サイズ上限が不正です。");
  for (let attempt = 1; attempt <= 2; attempt++) {
    let current = url;
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      for (let redirect = 0; redirect <= 5; redirect++) {
        validateUrl(current);
        const response = await fetchImpl(current, { method: "GET", headers, redirect: "manual", signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location || redirect === 5) throw Object.assign(new Error("リダイレクト先がないか回数上限を超えました。"), { code: "web_fetch_redirect" });
          current = new URL(location, current).href; continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw Object.assign(new Error(`Web読取 HTTP ${response.status}`), { upstream_status: response.status });
        }
        if (Number(response.headers.get("content-length")) > maxBytes) {
          await response.body?.cancel();
          throw Object.assign(new Error(`取得ページが${maxBytes}バイトの上限を超えました。`), { code: "web_fetch_too_large" });
        }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw Object.assign(new Error(`取得ページが${maxBytes}バイトの上限を超えました。`), { code: "web_fetch_too_large" });
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        return { raw: Buffer.concat(chunks).toString("utf8"), bytes: size, contentType: response.headers.get("content-type") || "", status: response.status, final_url: current, attempts: attempt };
      }
    } catch (error) {
      const details = webFailure(error);
      if (!details.retryable || details.upstream_status === 429 || attempt === 2) throw Object.assign(new Error(details.code === "web_fetch_timeout" ? "URLの取得がタイムアウトしました。" : error.message || "Web読取に失敗しました。"), details, { code: error.code || details.code, attempts: attempt });
      await retryDelay();
    }
  }
}
