# Going live

Production runs on **Supabase** (database, auth, storage) and **Vercel** (web app).

1. Create a Supabase project. Note the project URL, project ref, publishable key and database password, and create an access token.
2. Add the repository secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD`. Then run **Actions → Deploy database → Run workflow**. After that, every push to `main` that changes `supabase/migrations/**` applies the new migrations automatically.
3. Import the repository in Vercel and set these environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `NEXT_PUBLIC_SITE_URL` (the public https address)
4. In Supabase, go to **Authentication → URL Configuration**. Set the Site URL to the Vercel address and add `<address>/**` as a redirect URL.

`seed.sql` (the demo restaurants) is **not** applied in production. `supabase db push` only runs migrations.

The service-role key is never needed by the web app. Don't add it to Vercel.
