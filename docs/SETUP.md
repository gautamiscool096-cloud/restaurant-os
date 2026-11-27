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

## Online payments (Razorpay)

Until Razorpay is connected, guests pay at the table and staff record it on the **Bills** screen. A platform admin can turn on **test mode**, which lets you demo online payment without real money.

To take real payments:

1. In Razorpay, activate your account and enable **Route** (so each restaurant's money goes to its own linked account).
2. In Vercel, add the server-only variables `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (Razorpay → Account & Settings → API keys), then redeploy.
3. In Razorpay → Webhooks, add `<your site>/api/razorpay/webhook` with the events `payment.captured`, `payment.failed`, `order.paid`, `transfer.processed` and `refund.processed`. Choose a webhook secret.
4. Sign in as a platform admin, open **Admin → Payments**, paste the webhook secret, and turn test mode off. The secret is stored in the database and is never shown again.
5. For each restaurant, set its Razorpay linked account id in **Admin → Restaurants**. Its payouts then go straight to that account, minus the platform fee.

## Demo data

`supabase/seed.sql` creates three demo restaurants. `supabase/demo-history.sql` adds 30 days of past service to them so the Analytics screen has something to show. Use both only on a demo database, never in production.
