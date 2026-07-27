#!/usr/bin/env node
import { readFile, readdir } from 'fs/promises'
import { extname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ignoredDirectories = new Set(['.git', 'node_modules', 'docs/dogfood'])
const ignoredFiles = new Set(['scripts/audit-open-source.mjs'])
const textExtensions = new Set(['', '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.md', '.mjs', '.py', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml'])

const rules = [
  { name: 'private IPv4 address', pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', pattern: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/g },
  { name: 'generic secret assignment', pattern: /\b(?:client[_-]?secret|runner[_-]?token|api[_-]?key|password)\s*[:=]\s*["']?(?!\$\{|<|your-|example|placeholder|\*{3})[A-Za-z0-9_./+=:-]{12,}/gi },
  { name: 'fixed Capital Agent credential', pattern: /\b(?:niko-admin-fixed-key|car_[A-Za-z0-9_-]{16,}|runner_[A-Za-z0-9_-]{24,})\b/g },
  { name: 'enterprise project detail', pattern: /\b(?:financial\/gu-bei|dev_huifu|pay_channel_account|PayApproach|DescriptorService)\b|汇付|中金/g },
]

async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const name = relative(root, absolute).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(name) && !ignoredDirectories.has(entry.name)) files.push(...await collect(absolute))
    } else if (entry.isFile() && !ignoredFiles.has(name) && textExtensions.has(extname(entry.name))) files.push({ absolute, name })
  }
  return files
}

const findings = []
for (const file of await collect(root)) {
  const content = await readFile(file.absolute, 'utf8').catch(() => '')
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    for (const match of content.matchAll(rule.pattern)) {
      const line = content.slice(0, match.index).split('\n').length
      findings.push(`${file.name}:${line} [${rule.name}] ${match[0].slice(0, 80)}`)
    }
  }
}

if (findings.length) {
  process.stderr.write(`Open-source audit failed (${findings.length} findings):\n${findings.map(item => `- ${item}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('Open-source audit: PASS (no credentials, private network addresses, or enterprise project details found)\n')
