
import { assertPublicUrl } from "../../util/ssrf-guard.js";

export interface WebFetchArgs {
  url: string;
  extractText?: boolean;
}

export async function webFetchTool(args: WebFetchArgs): Promise<{
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}> {
  let url = args.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  // Reject SSRF targets (localhost, private/link-local/metadata IPs, internal
  // hostnames) before issuing the request. redirect:"follow" would otherwise
  // let an external URL bounce into an internal endpoint.
  await assertPublicUrl(url);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Reaper/0.1 (Reaper; +https://github.com/reaper-agent)",
      Accept: "text/html,application/json,text/plain,*/*",
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });

  const contentType = res.headers.get("content-type") ?? "unknown";
  let text = await res.text();

  // Simple HTML to text extraction
  if (args.extractText !== false && contentType.includes("html")) {
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  const maxChars = 50_000;
  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars) + "\n\n... [truncated]";
  }

  return { url, status: res.status, contentType, text, truncated };
}
