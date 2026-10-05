// Deployed sites call same-origin /supabase, which netlify.toml proxies to the project,
// so browsers in Myanmar never contact *.supabase.co. Local servers have no proxy,
// so they talk to the project directly (needs a VPN in Myanmar).
const SUPABASE_PROJECT_URL = "https://lxtdrcfliprknmickpad.supabase.co";

const isLocalDev =
  typeof location === "undefined" ||
  location.protocol === "file:" ||
  ["localhost", "127.0.0.1"].includes(location.hostname);

export const supabaseConfig = {
  url: isLocalDev ? SUPABASE_PROJECT_URL : `${location.origin}/supabase`,
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4dGRyY2ZsaXBya25taWNrcGFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNzA0MDksImV4cCI6MjEwMTY0NjQwOX0.pOOhv7CtI9iLk-gGvfN9othZBzpirn3qcsCUjl0nCkk"
};

export const demoUser = {
  id: "demo-admin",
  uid: "demo-admin",
  email: "admin@example.com",
  role: "admin",
  name: "Demo Admin"
};
