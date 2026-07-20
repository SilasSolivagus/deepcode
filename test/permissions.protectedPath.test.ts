// test/permissions.protectedPath.test.ts —— S4 保护系统路径守卫
import { describe, it, expect } from 'vitest'
import {
  isProtectedSystemPath,
  detectDangerousRemoval,
  checkPermission,
  type PermissionContext,
} from '../src/permissions.js'

const HOME = '/home/tester'

describe('isProtectedSystemPath', () => {
  it('文件系统根 / 与家目录受保护', () => {
    expect(isProtectedSystemPath('/', HOME, 'linux')).toBe(true)
    expect(isProtectedSystemPath('/home/tester', HOME, 'linux')).toBe(true)
    expect(isProtectedSystemPath('/home/tester/', HOME, 'linux')).toBe(true)
  })
  it('根下任意一级目录受保护（/etc /usr /bin /var …）', () => {
    for (const p of ['/etc', '/usr', '/bin', '/var', '/System', '/Users', '/opt']) {
      expect(isProtectedSystemPath(p, HOME, 'linux')).toBe(true)
    }
  })
  it('整树通配 * 与 /* 受保护', () => {
    expect(isProtectedSystemPath('*', HOME, 'linux')).toBe(true)
    expect(isProtectedSystemPath('/home/*', HOME, 'linux')).toBe(true)
  })
  it('二级及更深路径不受保护（只护一级）', () => {
    expect(isProtectedSystemPath('/etc/foo', HOME, 'linux')).toBe(false)
    expect(isProtectedSystemPath('/usr/local/bin/x', HOME, 'linux')).toBe(false)
    expect(isProtectedSystemPath('/home/tester/proj', HOME, 'linux')).toBe(false)
  })
  it('macOS 折叠 /private/{etc,var,tmp,home}', () => {
    expect(isProtectedSystemPath('/private/etc', HOME, 'darwin')).toBe(true)
    expect(isProtectedSystemPath('/private/var', HOME, 'darwin')).toBe(true)
    // linux 下 /private/etc 是二级路径，不折叠 → 不护
    expect(isProtectedSystemPath('/private/etc', HOME, 'linux')).toBe(false)
  })
})

describe('detectDangerousRemoval', () => {
  const cwd = '/home/tester/proj'
  const d = (cmd: string) => detectDangerousRemoval(cmd, cwd, HOME)

  it('rm -rf / 与 /etc → 命中关键系统路径', () => {
    expect(d('rm -rf /')).not.toBeNull()
    expect(d('rm -rf /etc')).not.toBeNull()
    expect(d('rmdir /usr')).not.toBeNull()
  })
  it('rm -rf ~ 与 * → 命中', () => {
    expect(d('rm -rf ~')).not.toBeNull()
    expect(d('rm -rf *')).not.toBeNull()
    expect(d('rm -rf ./*')).not.toBeNull()
  })
  it('删工作目录或其父目录 → 命中', () => {
    expect(d('rm -rf .')).not.toBeNull()          // cwd 自身
    expect(d('rm -rf /home/tester/proj')).not.toBeNull()
    expect(d('rm -rf ..')).not.toBeNull()         // 父目录
  })
  it('cd 换目录后相对目标无法静态解析 → 命中', () => {
    expect(d('cd / && rm -rf etc')).not.toBeNull()
  })
  it('普通项目内删除不命中（node_modules/build/子文件）', () => {
    expect(d('rm -rf node_modules')).toBeNull()
    expect(d('rm -rf build/cache')).toBeNull()
    expect(d('rm foo.txt')).toBeNull()
  })
  it('非删除命令不命中', () => {
    expect(d('npm test')).toBeNull()
    expect(d('git status')).toBeNull()
  })
  it('复合命令里的危险 rm 也被抓', () => {
    expect(d('npm run build && rm -rf /etc')).not.toBeNull()
  })
})

describe('detectDangerousRemoval 加固（opus 终审揪出的绕过）', () => {
  const cwd = '/home/tester/proj'
  const d = (cmd: string) => detectDangerousRemoval(cmd, cwd, HOME)

  it('分组 { } 与子shell ( ) 里的 rm 被抓', () => {
    expect(d('{ rm -rf /etc; }')).not.toBeNull()
    expect(d('(rm -rf /etc)')).not.toBeNull()
  })
  it('变量/命令替换目标 → 无法静态解析、强制问人', () => {
    expect(d('rm -rf $HOME')).not.toBeNull()
    expect(d('rm -rf ${HOME}')).not.toBeNull()
    expect(d('rm -rf $(echo /etc)')).not.toBeNull()
    expect(d('rm -rf `echo /etc`')).not.toBeNull()
  })
  it('wrapper（sudo/env/xargs/nice…）包裹的 rm 被抓', () => {
    expect(d('sudo rm -rf /etc')).not.toBeNull()
    expect(d('sudo -u root rm -rf /etc')).not.toBeNull()
    expect(d('env rm -rf /etc')).not.toBeNull()
    expect(d('xargs rm -rf /etc')).not.toBeNull()
    expect(d('timeout 5 rm -rf /etc')).not.toBeNull()
  })
  it('不误伤：引号内的 rm 文本、名字含 rm 的命令、无 rm 的复杂命令', () => {
    expect(d('echo "rm -rf /etc"')).toBeNull()      // 引号内是单 token，非命令
    expect(d('npm run rm-temp')).toBeNull()         // rm-temp 不是 rm
    expect(d('echo $(date)')).toBeNull()            // 复杂但无 rm
  })
  it('复杂命令（反引号/命令替换）里路径前缀或反引号相邻的 rm 也被抓', () => {
    expect(d('`rm -rf /etc`')).not.toBeNull()
    expect(d('$(/bin/rm -rf /etc)')).not.toBeNull()
    expect(d('$(/usr/bin/rm -rf /etc)')).not.toBeNull()
    expect(d('foo|`rm -rf /etc`')).not.toBeNull()
  })
  it('不误伤：名字含 rm 的复杂命令替换（warm/alarm/firmware/git status）', () => {
    expect(d('$(git status)')).toBeNull()
    expect(d('alarm=$(date)')).toBeNull()
    expect(d('echo $(warm_up)')).toBeNull()
    expect(d('`chmod 755 firmware`')).toBeNull()
  })
})

const tool = (over: any = {}) => ({ name: 'Bash', isReadOnly: false, needsPermission: (i: any) => i.command, ...over })
const ctx = (over: Partial<PermissionContext> = {}): PermissionContext =>
  ({ mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no', cwd: '/home/tester/proj', ...over })

describe('S4 checkPermission 守卫', () => {
  it('rm -rf /etc 在 yolo 模式下也强制问人（yolo 也绕不过）', async () => {
    let asked = 0
    const r = await checkPermission(tool() as any, { command: 'rm -rf /etc' },
      ctx({ mode: 'yolo', ask: async () => { asked++; return 'no' } }))
    expect(asked).toBe(1)
    expect(r.ok).toBe(false)
  })
  it('rm -rf /etc 即使有 allow 规则也强制问人（不能被规则自动放行）', async () => {
    let asked = 0
    const r = await checkPermission(tool() as any, { command: 'rm -rf /etc' },
      ctx({ rules: ['Bash(rm:*)'], ask: async () => { asked++; return 'yes' } }))
    expect(asked).toBe(1)
    expect(r.ok).toBe(true) // 用户 yes → 放行本次
  })
  it('用户确认后放行本次但不存规则', async () => {
    let saved: string | null = null
    const r = await checkPermission(tool() as any, { command: 'rm -rf /' },
      ctx({ mode: 'yolo', ask: async () => 'always', saveRule: (rr) => { saved = rr } }))
    expect(r.ok).toBe(true)
    expect(saved).toBeNull() // always 也不持久化（不可自动放行）
  })
  it('普通 rm 不触发守卫（yolo 直接放行、不问）', async () => {
    let asked = 0
    const r = await checkPermission(tool() as any, { command: 'rm -rf node_modules' },
      ctx({ mode: 'yolo', ask: async () => { asked++; return 'no' } }))
    expect(asked).toBe(0)
    expect(r.ok).toBe(true)
  })
})
