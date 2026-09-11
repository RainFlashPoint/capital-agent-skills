import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'

// JSON.parse silently overwrites duplicate keys; reject them before parsing trusted boundary inputs.
function parseJsonChecked(text) {
  if(typeof text!=='string'||Buffer.byteLength(text)>4*1024*1024) throw new Error('json_size_limit')
  let pos=0,nodes=0
  const space=()=>{while(/\s/.test(text[pos]??'')&&pos<text.length)pos++}
  const string=()=>{const start=pos++;let escaped=false;while(pos<text.length){const c=text[pos++];if(!escaped&&c==='"')return JSON.parse(text.slice(start,pos));if(!escaped&&c==='\\')escaped=true;else escaped=false}throw new Error('json_unterminated_string')}
  function visit(depth=0) {
    if(depth>48||++nodes>50000)throw new Error('json_complexity_limit')
    space();const c=text[pos]
    if(c==='"'){string();return}
    if(c==='{'||c==='[') {
      pos++;space();const end=c==='{'?'}':']',keys=new Set()
      if(text[pos]===end){pos++;return}
      while(pos<text.length) {
        space()
        if(c==='{') {
          if(text[pos]!=='"')throw new Error('json_expected_key')
          const key=string();if(keys.has(key))throw new Error('json_duplicate_key');keys.add(key)
          if(['__proto__','constructor','prototype'].includes(key))throw new Error('json_unsafe_key')
          space();if(text[pos++]!==':')throw new Error('json_expected_colon')
        }
        visit(depth+1);space();const next=text[pos++];if(next===end)return;if(next!==',')throw new Error('json_expected_separator')
      }
      throw new Error('json_unterminated_container')
    }
    const value=text.slice(pos).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
    if(!value)throw new Error('json_invalid_value')
    if(!['true','false','null'].includes(value)&&!Number.isFinite(Number(value)))throw new Error('json_nonfinite_number')
    pos+=value.length
  }
  visit();space();if(pos!==text.length)throw new Error('json_trailing_content')
  return JSON.parse(text)
}
export function parseJson(text) {
  try { return parseJsonChecked(text) } catch(error) {
    if(error instanceof SyntaxError)throw new Error('json_invalid_syntax')
    throw error
  }
}
export async function readJson(path) {
  if((await lstat(path)).isSymbolicLink())throw new Error('json_symlink_rejected')
  const f=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try {
    const info=await f.stat();if(!info.isFile()||info.size>4*1024*1024)throw new Error('json_size_limit')
    const buf=Buffer.alloc(4*1024*1024+1);let used=0
    while(used<buf.length){const r=await f.read(buf,used,buf.length-used,null);if(!r.bytesRead)break;used+=r.bytesRead}
    return parseJson(buf.subarray(0,used).toString('utf8'))
  }finally{await f.close()}
}
