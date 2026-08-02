# Google Sign-In and Approved Access Setup

## What the application enforces

- Supabase Auth owns the browser session.
- `src/middleware.ts` verifies the authenticated user with Supabase on every protected request.
- The user must match an enabled `approved_users` record and have a role assigned by the database trigger.
- `/admin` and `/audit-log` are server-enforced Admin-only routes.
- Viewer UI is read-only, but database RLS remains the actual write boundary.

## 1. Environment values

Set the Project URL and current publishable key from Supabase Dashboard → Project Settings → API in `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```
`NEXT_PUBLIC_SUPABASE_ANON_KEY` remains supported for legacy keys. Do not put a service-role key in browser code.

## 2. Configure Supabase URLs

In Supabase Dashboard → Authentication → URL Configuration:

- Set **Site URL** to the deployed dashboard URL.
- Add `http://localhost:3000/auth/callback` for local development.
- Add `https://your-production-domain/auth/callback` for production.

## 3. Configure Google

Create a **Web application** OAuth client in Google Cloud Console. Add this as an Authorized redirect URI:

```text
https://your-project-ref.supabase.co/auth/v1/callback
```

Add `http://localhost:3000` and the production site origin to Authorized JavaScript origins. In Supabase Dashboard → Authentication → Sign In / Providers → Google, enable Google and enter the Google OAuth client ID and secret. The app sends users to `/auth/callback` to exchange the authorization code for a secure session. See the [official Supabase Google guide](https://supabase.com/docs/guides/auth/social-login/auth-google).

## 4. Add the real allowlist before first sign-in

Replace every placeholder with the actual Google email, then run this in Supabase SQL Editor:

```sql
with requested_users(email, display_name, role_code) as (
  values
    ('fatema.hasan@replace-with-real-email', 'Fatema Hasan', 'admin'),
    ('walaa@replace-with-real-email', 'Walaa', 'admin'),
    ('mohammed@replace-with-real-email', 'Mohammed', 'admin'),
    ('wafa@replace-with-real-email', 'Wafa', 'viewer'),
    ('shreya@replace-with-real-email', 'Shreya', 'viewer')
)
insert into public.approved_users (email, display_name, default_role_id)
select requested_users.email::citext, requested_users.display_name, roles.id
from requested_users
join public.roles on roles.code = requested_users.role_code::public.access_role
on conflict (email) do update
  set display_name = excluded.display_name,
      default_role_id = excluded.default_role_id,
      enabled = true,
      disabled_at = null,
      updated_at = timezone('utc', now());
```

On first Google sign-in, the `on_auth_user_created` trigger creates the matching profile and assigns its allowlisted role.

## 5. Verify

1. Restart the development server after changing `.env.local`.
2. Sign in at `/login` with an allowlisted Admin account: it should reach `/executive` and access `/admin` and `/audit-log`.
3. Sign in with an allowlisted Viewer: it should reach `/executive`, remain read-only, and be redirected away from Admin-only routes.
4. A non-allowlisted account should reach `/access-denied`.

Google client secrets belong only in Google Cloud and Supabase Dashboard—not in this repository.
