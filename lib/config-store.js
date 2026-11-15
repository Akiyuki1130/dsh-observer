/**
 * dsh-observer 的本地配置存储。
 *
 * 为什么不用宿主的 configEditor：configEditor 每次保存都会重启插件，
 * 而观察者的设置（频率、模型、thinking 开关）需要即时生效且不能清空
 * 已经积累的播报历史。这里沿用 dsh-narrator 的成熟做法——把运行期配置
 * 写进 DSH_HOME 下自己的 JSON 文件，绝不触碰 profile 的 cordis.patch.yml。
 *
 * 文件权限固定 0600：secret.json 里存自定义端点的 API Key。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** DSH 数据根目录：优先 DSH_HOME，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件自己的配置目录。 */
export function configDir(home = dshHome()) {
  return join(home, 'observer')
}

export function configPath(home = dshHome()) {
  return join(configDir(home), 'config.json')
}

export function secretPath(home = dshHome()) {
  return join(configDir(home), 'secret.json')
}

async function readJson(file, onError) {
  try {
    const text = await readFile(file, 'utf8')
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch (error) {
    // 文件不存在是正常情况；损坏/权限问题要让人知道，否则用户配置会静默丢失
    if (error?.code !== 'ENOENT' && typeof onError === 'function') onError(error)
    return null
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  try {
    await chmod(file, 0o600)
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

export async function loadConfig(home, onError) {
  return (await readJson(configPath(home), onError)) ?? {}
}

export async function saveConfig(values, home) {
  await writeJson(configPath(home), values)
}

export async function loadSecret(home, onError) {
  return (await readJson(secretPath(home), onError)) ?? {}
}

export async function saveSecret(values, home) {
  await writeJson(secretPath(home), values)
}
