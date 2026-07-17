import { lstat, mkdir, readlink, symlink } from 'fs/promises'
import { basename, join } from 'path'

export function parseSetupArgs(argv = []) {
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] || '' : '' }
  return { server: value('--server'), project: argv.includes('--project'), doctor: argv.includes('--doctor'), upgrade: argv.includes('--upgrade'), configOnly: argv.includes('--config-only'), codexOnly: argv.includes('--codex-only'), claudeOnly: argv.includes('--claude-only') }
}

export async function installSkillLinks(sourceDir, targetDir) {
  const { readdir } = await import('fs/promises')
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const installed = []
  for (const entry of entries.filter(item => item.isDirectory())) {
    const source = join(sourceDir, entry.name); const target = join(targetDir, entry.name)
    try {
      const stat = await lstat(target)
      if (!stat.isSymbolicLink()) continue
      if (await readlink(target) === source) { installed.push(entry.name); continue }
      const { unlink } = await import('fs/promises'); await unlink(target)
    } catch {}
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    installed.push(entry.name)
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
