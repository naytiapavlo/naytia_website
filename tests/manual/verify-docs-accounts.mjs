// 验收脚手架：给隔离的验收后端建三个账号（超管 / 管理员 / 会员）。
// 用法：node tests/manual/verify-docs-accounts.mjs [base]
// 验收库是 .verify/verify.db，与真实数据完全隔离，不会碰到站长的账号。
const BASE = process.argv[2] ?? 'http://127.0.0.1:8123';

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    cookie: setCookie.map((c) => c.split(';')[0]).join('; '),
  };
}

const accounts = [
  { username: '验收站长', role: 'superadmin' },
  { username: '验收管理员', role: 'admin' },
  { username: '验收会员', role: 'member' },
];

const created = [];
for (const account of accounts) {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { username: account.username, password: 'verify123' },
  });
  if (res.status !== 201) {
    console.log(`注册失败 ${account.username}: ${res.status} ${JSON.stringify(res.json)}`);
    process.exit(1);
  }
  created.push({ ...account, id: res.json.id, actualRole: res.json.role });
}

// 第二个账号需要超管提权，走的就是站上真实的角色管理接口
const boss = await call('/api/auth/login', {
  method: 'POST',
  body: { username: '验收站长', password: 'verify123' },
});
const admin = created.find((a) => a.role === 'admin');
const promoted = await call(`/api/admin/accounts/${admin.id}/role`, {
  method: 'PUT',
  cookie: boss.cookie,
  body: { role: 'admin' },
});
if (promoted.status !== 200) {
  console.log(`提权失败: ${promoted.status} ${JSON.stringify(promoted.json)}`);
  process.exit(1);
}

for (const account of created) {
  console.log(`${account.username}: id=${account.id} role=${account.actualRole}`);
}
console.log('验收账号就绪（密码均为 verify123）');
