const dns = require('node:dns')
const { join } = require('node:path')
const { homedir } = require('node:os')
const { resolveSystemAddresses } = require('./system-dns.cjs')

const originalLookup = dns.lookup.bind(dns)
const lookupWithSystemFallback = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {} }
  if (typeof options === 'number') options = { family: options }
  options ||= {}
  return originalLookup(hostname, options, (error, address, family) => {
    if (!error || !['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code)) return callback(error, address, family)
    const records = resolveSystemAddresses(hostname).map(value => ({ address: value, family: value.includes(':') ? 6 : 4 }))
    const filtered = options.family ? records.filter(item => item.family === options.family) : records
    if (!filtered.length) return callback(error)
    if (options.all) return callback(null, filtered)
    callback(null, filtered[0].address, filtered[0].family)
  })
}

dns.lookup = lookupWithSystemFallback

try {
  const runtimeRoot = process.env.CAPITAL_AGENT_MCP_RUNTIME_DIR || join(homedir(), '.capital-agent', 'mcp-runtime')
  const undici = require(join(runtimeRoot, 'node_modules', 'undici'))
  const serverHostname = String(process.env.CAPITAL_AGENT_SERVER_URL || '').replace(/^https?:\/\//, '').split(/[/:]/)[0]
  const address = serverHostname ? resolveSystemAddresses(serverHostname)[0] : ''
  const lookup = address
    ? (_hostname, options, callback) => options?.all ? callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]) : callback(null, address, address.includes(':') ? 6 : 4)
    : lookupWithSystemFallback
  const dispatcher = new undici.Agent({ connect: { lookup } })
  undici.setGlobalDispatcher(dispatcher)
  globalThis.fetch = (input, init = {}) => undici.fetch(input, { ...init, dispatcher })
  globalThis.Headers = undici.Headers
  globalThis.Request = undici.Request
  globalThis.Response = undici.Response
} catch {}
