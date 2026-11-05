# [Paypal AI Hackathon] Burn The Boat

React, TypeScript, Vite, and shadcn/ui app backed by Supabase (Auth, Postgres,
Realtime, Edge Functions) with PayPal-backed boat bets.

## Setup

### 0. Prerequisites

The project use all of these services, please make an account first for all of these below:
- Supabase
- Google AI Studio
- Paypal Developer

### 1. Frontend `.env`

Copy `.env.example` to `.env` and fill in:

| Variable                 | Value                               |
| ------------------------ | ----------------------------------- |
| `VITE_SUPABASE_URL`      | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase publishable key            |
| `VITE_GEMINI_API_KEY`    | Google Gemini API key               |
| `VITE_PAYPAL_CLIENT_ID`  | PayPal REST app client ID (public)  |

`VITE_*` values end up in the browser. Never put secrets in them.

### 2. Database

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
```

### 3. Supabase Auth settings (dashboard)

- Set the site URL and redirect URLs (local and deployed).
- Enable Google, anonymous sign-in, and **Manual Linking**.
- Configure email confirmation and SMTP. (optional, well I didn't)

### 4. Edge Function secrets

These are read by Edge Functions only. Your `.env` is not used on the server.

```bash
npx supabase secrets set \
  SERVICE_ROLE_KEY=<service-role-key> \
  PAYPAL_CLIENT_ID=<paypal-client-id> \
  PAYPAL_CLIENT_SECRET=<paypal-client-secret> \
  PAYPAL_ENV=sandbox
```

### 5. Deploy Edge Functions

```bash
npx supabase functions deploy delete-account
npx supabase functions deploy cleanup-inactive-guests
npx supabase functions deploy boat-stakes
npx supabase functions deploy settle-boat-stakes --no-verify-jwt
```

### 6. Vault secrets (for scheduled jobs)

The database cron jobs (daily guest cleanup at 03:00 UTC, boat settlement every
5 minutes) call Edge Functions and can only read Vault. Run this once in the
Supabase SQL Editor (never in a migration, the key would leak):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');
```

Update the Vault secret if you rotate the service role key. Note that
`db reset` wipes Vault, so add them again afterwards.

### 7. PayPal

Create a PayPal REST app (sandbox first) with **Payouts** enabled. Bets use
`AUTHORIZE`: nobody is charged unless they lose. Captures go to your merchant
account, then a PayPal Payout sends the winner's amount to their PayPal email.
A user who bets $0 types the email for their winnings in the boat's payment
panel.

- Deadlines are capped at 29 days (PayPal authorization lifetime).
- Authorizations are guaranteed for 3 days. Longer boats are re-authorized once
  near the deadline, and bets on them are capped at $50.
- Free Supabase projects pause after a week of inactivity, which stops cron.
  Keep the project active (or use Pro) before using real money.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
```

## Disclosure

Well frankly I vibe coded most of these. Typescript and everything here are new to me (I'm a Python dev anyway), I can take time and can build all of these anyway; but with the incoming deadline, I have to rely on Vscode Copilot. Well and I want to see what I can do with AI too, and its too fast...

So if you want to use this project for your service, please, please, and please, read the whole Supabase migrations again and check if anything leaks. Security is my worst thing here. I had proofread, but there might be error due to being vibed code. Please check the whole thing before giving to your customers.