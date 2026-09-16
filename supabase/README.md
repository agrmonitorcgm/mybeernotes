# Supabase setup

1. Create a Supabase project.
2. Open **SQL Editor**, paste `setup.sql`, and run it once.
3. In **Authentication → URL Configuration** set:
   - Site URL: `https://agrmonitorcgm.github.io/mybeernotes/`
   - Redirect URL: `https://agrmonitorcgm.github.io/mybeernotes/`
4. In **Project Settings → API** copy the Project URL and the Publishable key (or legacy `anon` key).
5. Put those two public values into `desktop/dist/config.js`.

Never put the `service_role` key into the repository or browser code.

After the first user signs in, they create a shared diary and send its eight-character invite code to the second user. Existing local records are uploaded during the first synchronization.
