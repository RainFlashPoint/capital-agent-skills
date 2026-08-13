const net = require('node:net')
const { execFileSync } = require('node:child_process')

function uniqueAddresses(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(value => net.isIP(value)))]
}

function parseResolverOutput(output = '', kind = '') {
  const text = String(output)
  if (kind === 'dscacheutil') return uniqueAddresses([...text.matchAll(/^ip_address:\s*(\S+)/gm)].map(match => match[1]))
  if (kind === 'getent') return uniqueAddresses(text.split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]))
  const answer = text.split(/Non-authoritative answer:/i)[1] || text.slice(Math.max(text.lastIndexOf('\nName:'), text.lastIndexOf('\r\nName:'), 0))
  return uniqueAddresses([...answer.matchAll(/^Address(?:es)?:\s*(\S+)/gm)].map(match => match[1]))
}

function resolveSystemAddresses(hostname, { platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  const attempts = platform === 'darwin'
    ? [['/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', hostname], 'dscacheutil'], ['nslookup', [hostname], 'nslookup']]
    : platform === 'win32'
      ? [['nslookup.exe', [hostname], 'nslookup']]
      : [['getent', ['ahosts', hostname], 'getent'], ['nslookup', [hostname], 'nslookup']]
  for (const [command, args, kind] of attempts) {
    try {
      const addresses = parseResolverOutput(execFileSyncImpl(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }), kind)
      if (addresses.length) return addresses
    } catch {}
  }
  return []
}

module.exports = { parseResolverOutput, resolveSystemAddresses }
