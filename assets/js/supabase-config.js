// Browser talks to same-origin /supabase; Netlify proxies to the real project.
// Real project host stays only in netlify.toml — clients never call *.supabase.co.
export const supabaseConfig = {
  url: `${typeof location !== "undefined" ? location.origin : ""}/supabase`,
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx4dGRyY2ZsaXBya25taWNrcGFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNzA0MDksImV4cCI6MjEwMTY0NjQwOX0.pOOhv7CtI9iLk-gGvfN9othZBzpirn3qcsCUjl0nCkk"
};

export const demoUser = {
  id: "demo-admin",
  uid: "demo-admin",
  email: "admin@example.com",
  role: "admin",
  name: "Demo Admin"
};
