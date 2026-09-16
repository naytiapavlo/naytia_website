/**
 * 账号管理（/admin/users/）的纯规则对照测试。
 *
 * 为什么值得单独测：这一页的每个按钮都在改别人的权限，而「界面判断」与
 * 「服务端判断」漂移时的表现最坏——按钮点得下去、请求却一定失败。
 * 这里把三条规则钉住：搜索匹配口径、管理员开关的文案、以及**哪些行不能改**。
 * 服务端那一侧的同名规则在 `backend/tests/test_admin_users.py`。
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adminToggleOn,
  isAdminTier,
  matchesSearch,
  roleCounts,
  roleLabel,
  rowCapability,
  toggleDone,
  togglePrompt,
} from '../src/modules/admin-users/rules';

const row = (id: number, username: string, role: 'member' | 'admin' | 'superadmin') =>
  ({ id, username, role });

describe('matchesSearch', () => {
  it('空搜索词匹配所有人', () => {
    assert.equal(matchesSearch('任何人', ''), true);
    assert.equal(matchesSearch('任何人', '   '), true);
  });

  it('按子串匹配，不要求从头匹配', () => {
    assert.equal(matchesSearch('帕芙洛的粉丝', '帕芙洛'), true);
    assert.equal(matchesSearch('帕芙洛', '粉丝'), false);
  });

  it('ASCII 大小写不敏感', () => {
    assert.equal(matchesSearch('Naytia', 'nayt'), true);
    assert.equal(matchesSearch('Naytia', 'NAYTIA'), true);
  });

  it('搜索词首尾空格被忽略', () => {
    assert.equal(matchesSearch('Naytia', '  nay  '), true);
  });

  it('正则元字符按普通字符处理（不会抛异常、也不会误匹配）', () => {
    assert.equal(matchesSearch('a_b', '_'), true);
    assert.equal(matchesSearch('axb', '_'), false);
    assert.equal(matchesSearch('a.b', '.'), true);
    assert.equal(matchesSearch('axb', '.'), false);
    assert.equal(matchesSearch('a+b', '+'), true);
    assert.equal(matchesSearch('anything', '('), false); // 未转义的正则会在这一步炸掉
  });
});

describe('roleLabel / isAdminTier / adminToggleOn', () => {
  it('角色文案与导航角标用的是同一份表', () => {
    assert.equal(roleLabel('member'), '会员');
    assert.equal(roleLabel('admin'), '管理员');
    assert.equal(roleLabel('superadmin'), '超级管理员');
  });

  it('超管也算管理员档位', () => {
    assert.equal(isAdminTier('admin'), true);
    assert.equal(isAdminTier('superadmin'), true);
    assert.equal(isAdminTier('member'), false);
  });

  it('开关的「已开启」状态跟随实际管理能力，而不是角色的字面值', () => {
    assert.equal(adminToggleOn('member'), false);
    assert.equal(adminToggleOn('admin'), true);
    assert.equal(adminToggleOn('superadmin'), true);
  });
});

describe('rowCapability（哪些行不能改）', () => {
  it('普通会员可以切换', () => {
    const cap = rowCapability(row(2, '路人甲', 'member'), 1);
    assert.equal(cap.canToggle, true);
    assert.equal(cap.reason, null);
  });

  it('已经是管理员的行可以取消（按钮文案朝另一个方向）', () => {
    assert.equal(rowCapability(row(2, '路人甲', 'admin'), 1).canToggle, true);
  });

  it('自己的行不能改（与服务端 self_role_change 对应）', () => {
    const cap = rowCapability(row(1, '站长', 'superadmin'), 1);
    assert.equal(cap.canToggle, false);
    assert.equal(cap.reason, '不能修改自己的角色');
  });

  it('超管的行不能降级（与服务端 is_superadmin 对应）', () => {
    const cap = rowCapability(row(3, '副站长', 'superadmin'), 1);
    assert.equal(cap.canToggle, false);
    assert.match(cap.reason ?? '', /超级管理员/);
  });

  it('「自己」优先于「超管」：自己那一行永远显示自改的理由', () => {
    // 顺序很重要：超管看自己那一行时，说「不能修改自己的角色」比说
    // 「超管身份不能取消」更贴近他实际想做的事（他也是唯一能看这一页的人）
    const cap = rowCapability(row(1, '站长', 'superadmin'), 1);
    assert.equal(cap.reason, '不能修改自己的角色');
  });

  it('还不知道自己是谁时（selfId=null）不误判成「自己」', () => {
    assert.equal(rowCapability(row(1, '站长', 'member'), null).canToggle, true);
    assert.equal(rowCapability(row(1, '站长', 'superadmin'), null).canToggle, false);
  });
});

describe('togglePrompt / toggleDone', () => {
  it('两个方向的话术都说清后果，且带上用户名', () => {
    const grant = togglePrompt('路人甲', true);
    assert.match(grant, /路人甲/);
    assert.match(grant, /设为管理员/);
    assert.match(grant, /审核/); // 说清「多了什么能力」，不是只说「你确定吗」

    const revoke = togglePrompt('路人甲', false);
    assert.match(revoke, /路人甲/);
    assert.match(revoke, /取消/);
    assert.match(revoke, /退回普通会员/); // 说清「失去什么」
  });

  it('结果提示与操作方向对称', () => {
    assert.equal(toggleDone('路人甲', true), '「路人甲」已设为管理员');
    assert.equal(toggleDone('路人甲', false), '已取消「路人甲」的管理员身份');
  });
});

describe('roleCounts', () => {
  it('分档计数；管理员数**不含**超管（两者分开展示）', () => {
    const counts = roleCounts([
      row(1, '站长', 'superadmin'),
      row(2, '管理员甲', 'admin'),
      row(3, '管理员乙', 'admin'),
      row(4, '路人甲', 'member'),
      row(5, '路人乙', 'member'),
      row(6, '路人丙', 'member'),
    ]);
    assert.deepEqual(counts, { member: 3, admin: 2, superadmin: 1 });
  });

  it('空列表是三个 0，而不是 undefined', () => {
    assert.deepEqual(roleCounts([]), { member: 0, admin: 0, superadmin: 0 });
  });
});
