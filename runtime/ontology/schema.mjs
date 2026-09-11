import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const names = ['record', 'query', 'authority', 'instance', 'binding', 'graph']
const schemas = Object.fromEntries(names.map(name => [name, JSON.parse(readFileSync(new URL(`../../ontology/schemas/${name}.json`, import.meta.url), 'utf8'))]))
const supported = new Set(['$schema','title','type','properties','required','additionalProperties','items','maxItems','enum','const','anyOf','minLength','maxLength','pattern','minimum','format'])
export function assertSchemaSupported(s) {
  for (const k of Object.keys(s)) if (!supported.has(k)) throw new Error(`schema_unsupported_keyword:${k}`)
  for (const p of Object.values(s.properties ?? {})) assertSchemaSupported(p)
  if (s.items) assertSchemaSupported(s.items)
  for (const p of s.anyOf ?? []) assertSchemaSupported(p)
}
for (const schema of Object.values(schemas)) assertSchemaSupported(schema)
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v))
const typeOf = (v,t) => t === 'null' ? v === null : t === 'object' ? plain(v) : t === 'array' ? Array.isArray(v) : t === 'integer' ? Number.isSafeInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t
export function checkSchema(s, v, p='$') {
  if (s.anyOf) { if (s.anyOf.some(x=>checkSchema(x,v,p).length===0)) return []; return [`${p}:anyOf`] }
  const errors=[]
  if (Object.hasOwn(s,'const') && v!==s.const) errors.push(`${p}:const`)
  if (s.enum && !s.enum.some(x=>x===v)) errors.push(`${p}:enum`)
  if (s.type && !(Array.isArray(s.type)?s.type:[s.type]).some(t=>typeOf(v,t))) return [...errors,`${p}:type`]
  if (typeof v==='string') {
    if (v.length<(s.minLength??0)||v.length>(s.maxLength??Infinity)) errors.push(`${p}:length`)
    if (s.pattern&&!new RegExp(s.pattern).test(v)) errors.push(`${p}:pattern`)
    if (s.format==='date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)) errors.push(`${p}:date-time`)
  }
  if (typeof v==='number' && (!Number.isFinite(v)||v<(s.minimum??-Infinity))) errors.push(`${p}:number`)
  if (Array.isArray(v)) {
    if (v.length>(s.maxItems??Infinity)) errors.push(`${p}:maxItems`)
    if (s.items) v.forEach((item,i)=>errors.push(...checkSchema(s.items,item,`${p}[${i}]`)))
  }
  if (plain(v)) {
    for (const k of s.required??[]) if (!Object.hasOwn(v,k)) errors.push(`${p}.${k}:required`)
    for (const k of Object.keys(v)) {
      if (['__proto__','constructor','prototype'].includes(k)) { errors.push(`${p}:unsafe_key`);continue }
      if (!Object.hasOwn(s.properties??{},k)) { if(s.additionalProperties===false) errors.push(`${p}.${k}:additional`);continue }
      errors.push(...checkSchema(s.properties[k],v[k],`${p}.${k}`))
    }
  }
  return errors
}
export function validate(kind,value) {
  if(!Object.hasOwn(schemas,kind)) throw new Error('schema_unknown_kind')
  const errors=checkSchema(schemas[kind],value)
  if(errors.length) throw new Error(`schema_invalid:${kind}:${errors.slice(0,8).join(',')}`)
  return value
}
export function validWindow(from,until) { return until===null || Date.parse(until)>Date.parse(from) }
export function active(from,until,now) { return validWindow(from,until)&&Date.parse(from)<=Date.parse(now)&&(until===null||Date.parse(now)<Date.parse(until)) }
