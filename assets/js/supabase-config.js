// The browser never receives the Supabase URL or anon key.
// Netlify's edge proxy adds them from site environment variables.
export const supabaseConfig = {
  url: `${typeof location !== "undefined" ? location.origin : ""}/supabase`,
  anonKey: "public"
};

export const demoUser = {
  id: "demo-admin",
  uid: "demo-admin",
  email: "admin@example.com",
  role: "admin",
  name: "Demo Admin"
};
