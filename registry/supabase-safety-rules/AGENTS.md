# Supabase safety rules

Follow these whenever the project uses Supabase. They exist because each one is a way apps built quickly have leaked user data.

## Keys
- The `service_role` key bypasses every security rule. It must never appear in frontend code, in any file bundled for the browser, or in a variable prefixed `VITE_`, `NEXT_PUBLIC_` or `EXPO_PUBLIC_`.
- Only the `anon` (publishable) key may be used in the browser.
- Never write a real key into a committed file. Use environment variables and keep `.env` in `.gitignore`.

## Row-level security
- Every table in the `public` schema must have row-level security enabled in the same migration that creates it: `alter table <name> enable row level security;`
- A table with RLS enabled and no policies is locked. Add explicit policies; never "fix" access by disabling RLS.
- Policies that read user identity must use `auth.uid()`, never a user id sent from the client.
- `using (true)` on select, update or delete makes the table public. Only use it for data that is meant to be public, and say so in a comment.

## Functions and storage
- Database functions marked `security definer` run with elevated rights. Set `search_path` explicitly and check the caller inside the function.
- Storage buckets are private by default. Only make a bucket public for files anyone on the internet may download.

## Before you finish
- Tell the user which tables you created or changed and which policies protect them.
- If you could not add a policy, say so plainly instead of leaving the table open.
