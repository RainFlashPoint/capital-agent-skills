#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const RISK_REJECTION = /unacceptable risk|sensitive (?:data|metadata|information)|data policy|敏感(?:数据|信息|元数据)|风险拒绝/i
const LABELED_SECRET = /((?:测试)?(?:商户号|商户编号|商户名称|公司名|公司名称|企业名|企业名称|账号|账户|用户名|客户号|手机号|身份证号|银行卡号|密钥|秘钥|密码|token|secret|api[_ -]?key|client[_ -]?secret|merchant[_ -]?(?:id|no|name))\s*(?:为|是|[:：=])?\s*)([^\s,，;；。]+)/gi
const CREDENTIAL_ASSIGNMENT = /\b(token|secret|password|passwd|api[_-]?key|client[_-]?secret)\s*[=:]\s*([^\s,;]+)/gi

export function isSensitiveRiskRejection(value = '') {
  return RISK_REJECTION.test(String(value))
}

export function sanitizeTaskText(value = '') {
  return String(value)
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1')
    .replace(LABELED_SECRET, '$1[仅本地配置]')
    .replace(CREDENTIAL_ASSIGNMENT, '$1=[仅本地配置]')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildSanitizedTaskRetry({ title = '', requirementText = '' } = {}) {
  const safeTitle = sanitizeTaskText(title) || '研发任务'
  const sanitized = sanitizeTaskText(requirementText)
  const suffix = '具体测试账号、商户、公司及凭据配置仅保留在本地，不上传平台。'
  return {
    title: safeTitle,
    requirementText: sanitized ? `${sanitized.replace(/[。；;]+$/, '')}；${suffix}` : `${safeTitle}；${suffix}`,
    sanitized: true,
    retryLimit: 1,
  }
}

async function readStdin() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const input = JSON.parse(await readStdin())
  process.stdout.write(`${JSON.stringify(buildSanitizedTaskRetry(input), null, 2)}\n`)
}
