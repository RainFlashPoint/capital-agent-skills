const dns = require('node:dns')
const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { homedir } = require('node:os')

const originalLookup = dns.lookup.bind(dns)
const lookupWithSystemFallback = function lookupWithSystemFallback(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (typeof options === 'number') options = { family: options }
  options ||= {}
  return originalLookup(hostname, options, (error, address, family) => {
    if (!error || !['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code)) return callback(error, address, family)
    systemAddresses(hostname, (fallbackError, addresses = []) => {
      if (fallbackError) return callback(error)
      const records = addresses.map(value => ({ address: value, family: value.includes(':') ? 6 : 4 }))
      const filtered = options.family ? records.filter(item => item.family === options.family) : records
      if (!filtered.length) return callback(error)
      if (options.all) return callback(null, filtered)
      callback(null, filtered[0].address, filtered[0].family)
    })
  })
}

function systemAddresses(hostname, callback) {
  execFile('/usr/bin/nslookup', [hostname], { encoding: 'utf8', timeout: 3000 }, (error, stdout = '') => {
    if (error) return callback(error)
    const answer = String(stdout).split(/Non-authoritative answer:/i)[1] || ''
    const addresses = [...answer.matchAll(/^Address:\s*([^\s]+)$/gm)].map(match => match[1]).filter(Boolean)
    if (!addresses.length) {
      const failure = new Error(`system DNS returned no address for ${hostname}`)
      failure.code = 'ENOTFOUND'
      return callback(failure)
    }
    callback(null, addresses)
  })
}

function systemAddressesSync(hostname) {
  try {
    const { execFileSync } = require('node:child_process')
    const stdout = execFileSync('/usr/bin/nslookup', [hostname], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const answer = String(stdout).split(/Non-authoritative answer:/i)[1] || ''
    return [...answer.matchAll(/^Address:\s*([^\s]+)$/gm)].map(match => match[1]).filter(Boolean)
  } catch { return [] }
}

dns.lookup = lookupWithSystemFallback
dns.promises.lookup = async function lookupPromiseWithSystemFallback(hostname, options = {}) {
  return await new Promise((resolve, reject) => lookupWithSystemFallback(hostname, options, (error, address, family) => {
    if (error) reject(error)
    else resolve(options?.all ? address : { address, family })
  }))
}

try {
  const undici = require(join(homedir(), '.capital-agent', 'mcp-runtime', 'node_modules', 'undici'))
  const hostname = String(process.env.CAPITAL_AGENT_SERVER_URL || '').replace(/^https?:\/\//, '').split(/[/:]/)[0]
  const address = hostname ? systemAddressesSync(hostname)[0] : ''
  const dispatcher = new undici.Agent({ connect: address ? { lookup: (_hostname, options, callback) => options?.all ? callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]) : callback(null, address, address.includes(':') ? 6 : 4) } : { lookup: lookupWithSystemFallback } })
  undici.setGlobalDispatcher(dispatcher)
  globalThis.fetch = (input, init = {}) => undici.fetch(input, { ...init, dispatcher })
  globalThis.Headers = undici.Headers
  globalThis.Request = undici.Request
  globalThis.Response = undici.Response
} catch {}
