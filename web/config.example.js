// Copy to web/config.js (not committed) or set LLAN_SUPABASE_URL / LLAN_SUPABASE_KEY on the static host.
// Use the publishable (anon) key: it is meant to be public and is limited by the RLS rules in supabase/web-access.sql.
// Never put the secret (service_role) key here.
export default {
  url: 'https://csbsrqbqnyiiwyypxyhj.supabase.co',
  key: 'sb_publishable_...',
};
