const key = process.env.MIMO_SEARCH_API_KEY || "";
console.log("MIMO_SEARCH_API_KEY present:", !!key);
console.log("Key starts with:", key.slice(0, 10));

if (!key) {
  console.log("No API key found, trying Serper instead");
  const serperKey = process.env.SERPER_SEARCH_API_KEY || "";
  console.log("SERPER_SEARCH_API_KEY present:", !!serperKey);
  if (serperKey) {
    fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "Node.js Express WebSocket chat app", num: 5 }),
    })
      .then((r) => r.json())
      .then((d) => {
        console.log("Serper results:", d.organic?.length || 0);
        if (d.organic?.length > 0) {
          console.log("First:", d.organic[0].title, d.organic[0].link);
        }
      })
      .catch((e) => console.log("Serper error:", e.message));
  }
  process.exit(0);
}

fetch("https://api.xiaomimimo.com/v1/chat/completions", {
  method: "POST",
  headers: { "api-key": key, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "mimo-v2.5-pro",
    messages: [{ role: "user", content: "Node.js Express WebSocket chat app tutorial" }],
    tools: [{ type: "web_search", max_keyword: 3, force_search: true, limit: 5 }],
    max_completion_tokens: 512,
    temperature: 0.5,
    top_p: 0.9,
    stream: false,
    thinking: { type: "disabled" },
  }),
})
  .then((r) => r.json())
  .then((d) => {
    const msg = d.choices?.[0]?.message;
    console.log("Has annotations:", Array.isArray(msg?.annotations));
    console.log("Annotations count:", msg?.annotations?.length || 0);
    if (msg?.annotations?.length > 0) {
      console.log("First anno:", JSON.stringify(msg.annotations[0]).slice(0, 200));
    }
    console.log("Content preview:", (msg?.content || "").slice(0, 300));
    if (!msg?.annotations?.length) {
      console.log("Full response:", JSON.stringify(d).slice(0, 500));
    }
  })
  .catch((e) => console.log("ERROR:", e.message));
