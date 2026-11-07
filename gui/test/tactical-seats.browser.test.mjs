import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
export default async function(t){
 const stage=await startStage()
 const issue=await stage.createIssue('Configure tactical seats')
 const browser=await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`,{token:stage.token})
 try{
  await browser.clickWhen(()=>browser.find('button','Run a playbook'))
  await browser.clickWhen(()=>browser.all('.pick').find(p=>p.querySelector('.pick__id')?.textContent==='implementation'))
  const select=()=>browser.all('select').find(s=>s.getAttribute('aria-label')==='auditor-1 model')
  await browser.until(()=>select(),{label:'optional auditor selector'})
  await browser.until(()=>browser.all('.row__role').length===3,{label:'default seats preview'})
  t.eq('auditor defaults to GPT-6.1 Sol',select().value,'gpt-6.1-sol')
  t.eq('coordinator, implementer and auditor occupied',browser.all('.row__role').length,3)
  select().value='gpt-6-astra';select().dispatchEvent(new browser.window.Event('change',{bubbles:true}))
  const auditorRow=()=>browser.all('.row').find(r=>r.querySelector('.row__role')?.textContent==='auditor-1')
  await browser.until(()=>auditorRow()?.textContent.includes('gpt-6-astra'),{label:'reassigned auditor preview'})
  t.ok('assigned seat reaches resolved preview',auditorRow()?.textContent.includes('gpt-6-astra'))
  select().value='';select().dispatchEvent(new browser.window.Event('change',{bubbles:true}))
  await browser.until(()=>browser.all('.row__role').length===2,{label:'cleared optional seat preview'})
  t.eq('clearing removes auditor from execution',browser.all('.row__role').length,2)
  await browser.clickWhen(()=>browser.find('button','Change playbook'))
  await browser.until(()=>browser.all('.pick').some(p=>p.querySelector('.pick__id')?.textContent==='deployment'),{label:'playbook list'})
  t.ok('the start dialog offers no Staging playbook',!browser.all('.pick').some(p=>p.querySelector('.pick__id')?.textContent==='staging'))
  await browser.clickWhen(()=>browser.all('.pick').find(p=>p.querySelector('.pick__id')?.textContent==='deployment'))
  const envSelect=()=>browser.all('select').find(s=>s.getAttribute('aria-label')==='Release environment')
  await browser.until(()=>envSelect(),{label:'release environment selector'})
  t.eq('deployment offers the three environments by name',[...envSelect().options].map(o=>o.textContent.trim()),['Staging','Production','Staging first, Deployment on success'])
  t.eq('deployment defaults to staging, never production',envSelect().value,'staging')
  t.ok('staging asks for no releaseId',!browser.all('input').some(e=>e.getAttribute('aria-label')==='Staged release ID'))
  t.ok('unconfigured deployment cannot start',browser.find('button','Start run')?.disabled)
  await browser.until(()=>browser.all('.chosen')[0]?.textContent.includes('cannot start'))
  t.ok('missing project configuration still warns',browser.all('.chosen')[0]?.textContent.includes('cannot start'))
  const environment=id=>({id,ssh:{hostRef:`ssh-config:${id}.invalid`,workdir:'/tmp'},projectRoot:'/tmp/fixture',files:{}})
  const target={workdir:'/tmp',ownership:'Fixture source only',rollback:'automatic',commands:Object.fromEntries(['inspect','checkpoint','verifyCheckpoint','apply','verifyRelease','restart','observe','test','restore','verifyRestore'].map(id=>[id,{run:'true',timeoutSeconds:10}]))}
  await fs.mkdir(path.join(stage.configRoot,'projects'),{recursive:true})
  await fs.writeFile(path.join(stage.configRoot,'projects',`${stage.project}.yaml`),YAML.stringify({id:stage.project,evidence:[],infrastructure:{kind:'boilerplate',orientation:'Test fixture only',staging:environment('stage'),deployments:[environment('prod')],testDrive:{requirement:'optional',commands:[{id:'noop',run:'true'}]},release:{targets:{stage:target,prod:target}}}}))
  // Another playbook first, so choosing deployment again previews the configuration just written.
  await browser.clickWhen(()=>browser.find('button','Change playbook'));await browser.clickWhen(()=>browser.all('.pick').find(p=>p.querySelector('.pick__id')?.textContent==='analysis'))
  await browser.clickWhen(()=>browser.find('button','Change playbook'));await browser.clickWhen(()=>browser.all('.pick').find(p=>p.querySelector('.pick__id')?.textContent==='deployment'))
  await browser.until(()=>browser.find('button','Start run')?.disabled===false,{label:'configured deployment to staging'})
  const deploymentChip=()=>browser.all('.chosen')[0]?.querySelector('.v-chip')
  t.ok('a deployment to staging starts without a releaseId',!deploymentChip())
  await browser.until(()=>envSelect(),{label:'release environment selector'})
  envSelect().value='production';envSelect().dispatchEvent(new browser.window.Event('change',{bubbles:true}))
  await browser.until(()=>browser.all('.chosen')[0]?.textContent.includes('no green staging release'),{label:'production without a green staging release'})
  t.ok('production without a green staging release cannot start',browser.find('button','Start run')?.disabled)
  t.ok('the page says there is no green staging release',browser.all('[data-latest-green]').some(e=>e.textContent.includes('There is no green staging release in this project')))
  const releaseInput=browser.all('input').find(e=>e.getAttribute('aria-label')==='Staged release ID')
  releaseInput.value='staged-fixture';releaseInput.dispatchEvent(new browser.window.Event('input',{bubbles:true}))
  await browser.until(()=>browser.find('button','Start run')?.disabled===false,{label:'deployment with a named releaseId'})
  t.ok('a named releaseId clears the refusal',!deploymentChip())
  t.eq('no browser errors',browser.problems.length,0)
 }finally{browser.close()}
}
