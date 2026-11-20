import type { OrcaWorkerApi, PanelRequestContext } from 'orca/worker'

// Validate before transport. Serializing here would hide missing fields and non-finite numbers.
function check(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return
  if (typeof value !== 'object') throw Error(`${path} (${typeof value === 'number' ? value : typeof value})`)
  if (ancestors.has(value)) throw Error(`${path} (循环引用)`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) check(value[i], `${path}[${i}]`, ancestors)
  } else {
    const ctor = value.constructor
    if (typeof ctor === 'function' && !Object.hasOwn(ctor.prototype ?? {}, 'isPrototypeOf')) throw Error(`${path} (非普通对象)`)
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue
      if (typeof key === 'symbol') throw Error(`${path}[Symbol] (非字符串字段名)`)
      const field = /^[$A-Z_a-z][$\w]*$/.test(key) ? '.' + key : '[' + JSON.stringify(key) + ']'
      check((value as Record<string, unknown>)[key], path + field, ancestors)
    }
  }
  ancestors.delete(value)
}

export function checkedPanels(api: OrcaWorkerApi): OrcaWorkerApi['panels'] {
  return { ...api.panels, handle(name: string, handler: (input: any, context: PanelRequestContext) => unknown) {
    return api.panels.handle(name, async (input, context) => {
      const result = await handler(input, context) ?? null
      try { check(result, '$', new Set()) }
      catch (e) {
        const message = `${name} 返回了无效的 JSON 字段：${(e as Error).message}`
        api.log(message)
        throw Error(message)
      }
      return result
    })
  } }
}
