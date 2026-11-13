// The office machine as the monitoring centre of the survey teams. It reaches Supabase with the secret key,
// so it sees every team and every surveyor and does what an admin does on the web page. The page's team
// code (public/survey.js) runs unchanged on the office page and calls these through /api/team/call.
const READ = /^(llan_teams|llan_members|llan_assignments|llan_plans|llan_locations|llan_work_log|llan_user_codes)(\?|$)/;
const WRITE = new Set(['llan_plans', 'llan_assignments']);
const enc = encodeURIComponent;
const fail = (code, message) => Object.assign(new Error(message), { code });
const newKey = () => {
  const ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ', part = () => Array.from({ length: 4 }, () => ABC[Math.floor(Math.random() * ABC.length)]).join('');
  return `${part()}-${part()}`;
};

// cloud(): a Cloud client with the secret key, or null when Supabase is not set up on this machine.
export function officeTeam(cloud) {
  const c = () => {
    const x = cloud();
    if (!x) throw fail(400, 'ยังไม่ได้เชื่อม Supabase ด้วย secret key (ตั้งค่า → Supabase)');
    return x;
  };
  const rpc = {
    llan_team_keys: () => c().get('llan_teams?select=id,name,color,join_key&order=name'),
    async llan_team_save({ p_id, p_name, p_color }) {
      const name = String(p_name || '').trim();
      if (!name) throw fail(400, 'ใส่ชื่อทีม');
      if (p_id) {
        await c().patch('llan_teams', `id=eq.${enc(p_id)}`, { name, ...(p_color ? { color: p_color } : {}) });
        return c().get(`llan_teams?select=*&id=eq.${enc(p_id)}`);
      }
      const row = { id: globalThis.crypto.randomUUID(), name, color: p_color || '#2f80ed', join_key: newKey(), created_by: 'สำนักงาน' };
      await c().upsertOn('llan_teams', [row], 'id');
      return [row];
    },
    async llan_team_delete({ p_id }) { await c().deleteWhere('llan_teams', `id=eq.${enc(p_id)}`); return null; },
    async llan_team_new_key({ p_id }) { const k = newKey(); await c().patch('llan_teams', `id=eq.${enc(p_id)}`, { join_key: k }); return k; },
    async llan_member_set({ p_email, p_team_id, p_team_role, p_role, p_name }) {
      const patch = { team_id: p_team_id || null };
      if (p_team_role) patch.team_role = p_team_role;
      if (p_role) patch.role = p_role;
      if (String(p_name || '').trim()) patch.display_name = String(p_name).trim();
      await c().patch('llan_members', `email=eq.${enc(p_email)}`, patch);
      return null;
    },
    async llan_add_by_code({ p_code, p_team_id, p_team_role, p_role }) {
      const code = String(p_code || '').trim().toUpperCase();
      const [u] = code ? await c().get(`llan_user_codes?select=*&code=eq.${enc(code)}`) : [];
      if (!u) throw fail(404, 'ไม่พบรหัสผู้ใช้นี้ ให้ผู้ใช้เปิดหน้าเว็บแล้วดูรหัสอีกครั้ง');
      if (!p_team_id) throw fail(400, 'เลือกทีมก่อน');
      const [old] = await c().get(`llan_members?select=email,display_name&email=eq.${enc(u.email)}`);
      await c().upsertOn('llan_members', [{ email: u.email, role: p_role || 'editor', team_id: p_team_id, team_role: p_team_role || 'member', display_name: old?.display_name || u.name || null }], 'email');
      return [{ email: u.email, name: u.name }];
    },
    async llan_pending_users() {
      const [codes, members] = await Promise.all([c().get('llan_user_codes?select=*&order=created_at.desc'), c().get('llan_members?select=email,team_id')]);
      const inTeam = new Set(members.filter(m => m.team_id).map(m => String(m.email).toLowerCase()));
      return codes.filter(x => !inTeam.has(String(x.email).toLowerCase()));
    },
  };
  return async function call({ op, args = [] } = {}) {
    const table = String(args[0] || '');
    switch (op) {
      case 'get': if (!READ.test(table)) throw fail(400, 'ไม่อนุญาต'); return c().get(table);
      case 'getAll': if (!READ.test(table)) throw fail(400, 'ไม่อนุญาต'); return c().getAll(...args);
      case 'upsertOn': if (!WRITE.has(table)) throw fail(400, 'ไม่อนุญาต'); return c().upsertOn(...args);
      case 'deleteWhere': if (!WRITE.has(table)) throw fail(400, 'ไม่อนุญาต'); return c().deleteWhere(...args);
      case 'insertRows': return null; // the office does not log field work
      case 'rpc': {
        const fn = rpc[table];
        if (!fn) throw fail(400, 'ใช้ที่เครื่องสำนักงานไม่ได้');
        return fn(args[1] || {});
      }
      default: throw fail(400, 'คำสั่งไม่ถูกต้อง');
    }
  };
}
