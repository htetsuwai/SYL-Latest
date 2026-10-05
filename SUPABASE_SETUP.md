# Supabase Setup

## 1. Create project

1. Go to [supabase.com](https://supabase.com) and create a project.
2. Pick a region close to Myanmar (e.g. Singapore).
3. Save your database password.

## 2. Run database schema

1. Open **SQL Editor** in Supabase.
2. Paste and run the full contents of [`supabase/schema.sql`](supabase/schema.sql).

This creates tables for products, sales, purchases, credits, expenses, stock damages, stock returns, settings, and RLS policies.

## 3. Enable email auth

1. **Authentication** → **Providers** → enable **Email**.
2. For testing, disable **Confirm email** so new users can sign in immediately.

## 4. Create admin user

1. **Authentication** → **Users** → **Add user**.
2. Set email + password (this is the login for the POS).
3. Copy the user's **UUID**.
4. In SQL Editor:

```sql
insert into profiles (id, email, name, role)
values (
  'PASTE-ADMIN-UUID-HERE',
  'admin@yourshop.com',
  'Admin',
  'admin'
);
```

Without a `profiles` row, login will fail with: **User profile not found**.

## 5. Configure the app

Edit [`assets/js/supabase-config.js`](assets/js/supabase-config.js):

```js
export const supabaseConfig = {
  // Same-origin proxy (see Netlify section). Do not put *.supabase.co here for production.
  url: `${typeof location !== "undefined" ? location.origin : ""}/supabase`,
  anonKey: "YOUR_ANON_PUBLIC_KEY"
};
```

Get the **anon public** key from **Project Settings** → **API**.

Put the real project URL only in [`netlify.toml`](netlify.toml) (proxy target). Use only the **anon public** key in the frontend. Never put the **service role** key in the browser.

When `anonKey` is set (not starting with `PASTE_`), the app leaves demo mode and uses live Supabase auth + data through the proxy.

## 6. Create sales users

1. Add user in Supabase Auth.
2. Insert profile with `role = 'sales'`.

```sql
insert into profiles (id, email, name, role)
values ('SALES-UUID', 'sales@yourshop.com', 'Sales Staff', 'sales');
```

## 7. Deploy to Netlify (Supabase proxy)

Browsers in Myanmar often cannot reach `*.supabase.co`. This app proxies Auth + REST through Netlify instead.

1. In [`netlify.toml`](netlify.toml), keep the proxy rule **above** the SPA fallback:

```toml
[[redirects]]
  from = "/supabase/*"
  to = "https://YOUR_PROJECT.supabase.co/:splat"
  status = 200
  force = true
```

2. Publish directory: `.` — no build command needed.
3. Redeploy after changing `supabase-config.js` or `netlify.toml`.

### Supabase dashboard URLs

In Supabase → **Authentication** → **URL configuration**:

- Set **Site URL** to your Netlify site (e.g. `https://your-site.netlify.app`)
- Add the same URL (and any custom domain) under **Redirect URLs**

Password login does not require email redirects, but this avoids future auth URL mismatches.

### Local development

On `localhost`, `127.0.0.1` or a `file:` page there is no Netlify proxy, so `supabase-config.js` automatically talks to `https://YOUR_PROJECT.supabase.co` directly. In Myanmar that needs a VPN while developing. Deployed Netlify sites always use the `/supabase` proxy.

If login on the deployed site says **Unexpected token '<'** or **Cannot reach the Supabase proxy**, Netlify is serving `index.html` for `/supabase/...`: check `netlify.toml` is in the published root and redeploy.

### Verify after deploy (no VPN)

1. Open the Netlify site in Myanmar without VPN.
2. Login, load products, complete a sale.
3. In DevTools → Network, confirm requests go to `yoursite/.../supabase/auth/v1/...` and `.../supabase/rest/v1/...`.
4. Confirm there are **no** requests to `*.supabase.co`.

## Demo mode

If `anonKey` still starts with `PASTE_`, the app uses local browser storage and demo login (`admin@example.com` / any password).

## Quick checklist

- [ ] Schema ran successfully in SQL Editor
- [ ] Email auth enabled (confirm email off for testing)
- [ ] Auth user created
- [ ] Matching `profiles` row with `admin` or `sales`
- [ ] `supabase-config.js` has anon key + same-origin `/supabase` URL
- [ ] `netlify.toml` proxies `/supabase/*` to your project
- [ ] Netlify site URL added in Supabase Auth URL settings
- [ ] Login screen says: **Connected to Supabase**
- [ ] Without VPN: Network tab shows `/supabase/...` only (no `supabase.co`)
