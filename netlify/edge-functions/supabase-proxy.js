export default async (request) => {
  const readEnv = (name) => {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name) || "";
    if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(name) || "";
    return "";
  };
  const supabaseUrl = readEnv("SUPABASE_URL");
  const anonKey = readEnv("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ message: "Shop server is not configured." }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }

  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/supabase\/?/, "");
  const base = supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`;
  const target = new URL(path + incoming.search, base);

  const headers = new Headers(request.headers);
  headers.set("apikey", anonKey);
  const token = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token === "public") {
    headers.set("authorization", `Bearer ${anonKey}`);
  }
  headers.delete("host");

  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body
  });
};

export const config = { path: "/supabase/*" };
