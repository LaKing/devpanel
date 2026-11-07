import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'schemas — every example validates against its own schema'

const SCHEMAS = ['harness-capabilities', 'roster-model', 'strategy-template', 'playbook',
  'agent-outputs', 'revision-fingerprint', 'run', 'lock']

export default async function (t) {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)

  t.section('schemas parse and compile')
  for (const n of SCHEMAS) {
    const file = path.join(CONFIG_ROOT, 'schemas', `${n}.schema.json`)
    let error = null
    try { ajv.addSchema(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch (e) { error = e }
    t.ok(`${n}.schema.json`, !error, error?.message)
  }

  const validate = (n, data) => {
    const v = ajv.getSchema(`https://devpanel/schemas/${n}.schema.json`)
    return v(data) ? null : v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
  }

  t.section('roster entries')
  for (const f of fs.readdirSync(path.join(CONFIG_ROOT, 'roster'))) {
    const data = YAML.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'roster', f), 'utf8'))
    t.ok(f, !validate('roster-model', data), validate('roster-model', data))
  }

  t.section('strategy templates')
  for (const d of fs.readdirSync(path.join(CONFIG_ROOT, 'strategy-templates'))) {
    const data = YAML.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'strategy-templates', d, 'strategy.yaml'), 'utf8'))
    t.ok(`${d}/strategy.yaml`, !validate('strategy-template', data), validate('strategy-template', data))
  }

  t.section('playbooks')
  for (const f of fs.readdirSync(path.join(CONFIG_ROOT, 'playbooks'))) {
    const data = YAML.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'playbooks', f), 'utf8'))
    t.ok(f, !validate('playbook', data), validate('playbook', data))
  }

  t.section('unknown is not unsupported')
  const read = (f) => YAML.parse(fs.readFileSync(path.join(CONFIG_ROOT, 'roster', f), 'utf8'))
  t.eq('haiku-4-5 declares no effort support, verified', read('haiku-4-5.yaml').efforts, [])
  t.eq('haiku-4-5 verification', read('haiku-4-5.yaml').verification.status, 'verified')
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    t.ok(`${model} has verified selectable efforts`, read(`${model}.yaml`).efforts?.length > 0)
    t.eq(`${model} retains the runtime default`, read(`${model}.yaml`).defaultEffort, null)
  }
  t.eq('deepseek effort levels remain unknown', read('deepseek-flash.yaml').efforts, null)
  t.eq('gpt-6-astra verification', read('gpt-6-astra.yaml').verification.status, 'verified')
}
