import { lstat, mkdir, readlink, symlink, unlink } from 'fs/promises'
import { basename, join } from 'path'

export const publicSkillNames = ['cap']
export const legacySkillNames = ['cap-map', 'cap-shape', 'cap-build', 'cap-verify']

export function parseSetupArgs(argv = []) {
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] || '' : '' }
  return { server: value('--server'), project: argv.includes('--project'), doctor: argv.includes('--doctor'), upgrade: argv.includes('--upgrade'), configOnly: argv.includes('--config-only'), codexOnly: argv.includes('--codex-only'), claudeOnly: argv.includes('--claude-only') }
}

export const skillTargets = home => ({ codex: join(home, '.agents/skills'), claude: join(home, '.claude/skills') })

export async function installSkillLinks(sourceDir, targetDir, skillNames = publicSkillNames) {
  const { readdir } = await import('fs/promises')
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const available = new Set(entries.filter(item => item.isDirectory()).map(item => item.name))
  const selected = [...new Set(skillNames)].filter(name => available.has(name))

  // 升级时清理旧版本安装的内部阶段链接。只删除仍指向本技能包 sourceDir 的软链接，
  // 不碰用户自己创建的目录、文件或指向其他来源的同名 Skill。
  for (const entry of entries.filter(item => item.isDirectory() && !selected.includes(item.name))) {
    const target = join(targetDir, entry.name)
    try {
      const stat = await lstat(target)
      if (stat.isSymbolicLink() && (await readlink(target)) === join(sourceDir, entry.name)) await unlink(target)
    } catch {}
  }
  for (const name of legacySkillNames) {
    const target = join(targetDir, name)
    try {
      const stat = await lstat(target)
      const linked = stat.isSymbolicLink() ? await readlink(target) : ''
      if (linked === join(sourceDir, name)) await unlink(target)
    } catch {}
  }

  const installed = []
  for (const name of selected) {
    const source = join(sourceDir, name); const target = join(targetDir, name)
    try {
      const stat = await lstat(target)
      if (!stat.isSymbolicLink()) continue
      if (await readlink(target) === source) { installed.push(name); continue }
      await unlink(target)
    } catch {}
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    installed.push(name)
  }
  return installed
}

export const normalizeServerUrl = value => {
  const url = new URL(String(value || '').trim().replace(/\/+$/, ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('平台地址必须是 HTTP(S)')
  return url.toString().replace(/\/+$/, '')
}

export async function pollDeviceAuthorization(serverUrl, secret, { fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), expiresIn = 600, interval = 2 } = {}) {
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    const response = await fetchImpl(`${serverUrl}/api/device-auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_secret: secret }) })
    const body = await response.json()
    if (response.ok && body.data?.user_key) return body.data.user_key
    if (response.status !== 202) throw new Error(body.msg || '设备授权失败')
    await wait(interval * 1000)
  }
  throw new Error('设备授权已超时，请重新运行安装')
}

export async function checkPlatformConnection(serverUrl, userKey, fetchImpl = fetch) {
  if (!serverUrl || !userKey) return false
  try {
    const response = await fetchImpl(`${serverUrl}/api/auth/heartbeat`, { method: 'PUT', headers: { 'x-user-key': userKey } })
    return response.ok
  } catch { return false }
}
