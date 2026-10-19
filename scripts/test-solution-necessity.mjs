import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('address-only migration cannot justify rebuilding a successful path', async () => {
  const reference = await read('skills/cap-flow/references/solution-necessity.md')
  assert.match(reference, /重新取证 ≠ 重新实现/)
  assert.match(reference, /更换构建工具或构建链路、基础镜像、源码导出\/过滤策略、依赖安装方式、产物布局、执行拓扑、配置打包方式/)
  assert.match(reference, /原始需求引用或已观察失败证据/)
  assert.match(reference, /spec、plan 和 diff 都是被审对象，不是扩张授权来源/)

  const consumers = await Promise.all([
    read('skills/cap-flow/references/task-reconnaissance.md'),
    read('skills/cap-plan/SKILL.md'),
    read('skills/cap-implement/SKILL.md'),
    read('skills/cap-review/SKILL.md')
  ])
  for (const consumer of consumers) assert.match(consumer, /solution-necessity\.md/)
  assert.match(consumers[0], /## Solution necessity/)
  assert.match(consumers[1], /不能用计划自身给扩张循环背书/)
  assert.match(consumers[2], /局部测试能通过/)
  assert.match(consumers[3], /用户原始意图.*优先于本轮自行生成的 spec\/plan/)
})
