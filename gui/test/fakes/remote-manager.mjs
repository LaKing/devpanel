import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
export async function installRemoteManager (dir) {
 const source=`#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
const args=process.argv.slice(2), dir=process.env.DEVPANEL_TEST_UNITS
fs.mkdirSync(dir,{recursive:true})
const alive=pid=>{try{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return !text.slice(text.lastIndexOf(')')+2).startsWith('Z')}catch{return false}}
if(path.basename(process.argv[1])==='systemd-run'){
 const unit=args.find(a=>a.startsWith('--unit=')).slice(7),file=path.join(dir,unit+'.json')
 // A timer is recorded, not run: fireTimer plays its firing.
 if(args.some(a=>a.startsWith('--on-active='))){
  fs.appendFileSync(path.join(dir,'invocations.jsonl'),JSON.stringify({unit,args})+'\\n')
  if(fs.existsSync(path.join(dir,'fail-arm'))){fs.writeSync(2,'no manager\\n');process.exit(1)}
  fs.writeFileSync(path.join(dir,unit+'.timer.json'),JSON.stringify({timer:true,script:args[args.indexOf('-c')+1].replaceAll('$$','$')}))
  process.exit(0)
 }
 const cwd=args.find(a=>a.startsWith('--property=WorkingDirectory=')).slice('--property=WorkingDirectory='.length)
 // The confined kinds (0e) run for real where they can: bubblewrap with the
 // ambient capabilities dropped, and the privileged mask inside a user
 // namespace mapped to root (a real root is not available to the suite).
 const index=args.findIndex(a=>a==='/usr/bin/bwrap'||a==='/usr/bin/unshare'||a==='/usr/bin/nsenter'||a==='/bin/sh')
 // systemd's own command-line expansion: \$\$ is a literal dollar.
 let command=args[index],rest=args.slice(index+1).map(a=>a.replaceAll('$$','$'))
 if(command==='/usr/bin/bwrap'){rest=['--ambient-caps','-all','--inh-caps','-all','bwrap',...rest.filter(a=>args.includes('--wait')||a!=='--die-with-parent')];command='setpriv'}
 if(command==='/usr/bin/unshare')rest=['--user','--map-root-user',...rest]
 // A suite about what the engine decides, not the fence, runs where bubblewrap cannot: the
 // run text in plain sh. A join's prelude finds no fence to enter, so it can only join what is down.
 if(fs.existsSync(path.join(dir,'no-fence'))&&(args[index]==='/usr/bin/bwrap'||args[index]==='/usr/bin/unshare')){rest=['-c',rest.at(-1)];command='/bin/sh'}
 const env={...process.env};for(const a of args.slice(0,index))if(a.startsWith('--setenv=')){const kv=a.slice(9),i=kv.indexOf('=');env[kv.slice(0,i)]=kv.slice(i+1)}
 fs.appendFileSync(path.join(dir,'invocations.jsonl'),JSON.stringify({unit,args})+'\\n')
 const service=!args.includes('--wait')
 const child=spawn(command,rest,{cwd,env,stdio:['ignore',service?'ignore':'pipe',service?'ignore':'pipe'],detached:true})
 fs.writeFileSync(file,JSON.stringify({pid:child.pid,invocationId:child.pid+'-'+Date.now()}))
 if(service){child.unref();process.exit(0)}
 // Forwarded synchronously, and exit waits for 'close': 'exit' can fire with the unit's last
 // output still unread, and a stream write can be lost when this process exits.
 child.stdout.on('data',bytes=>fs.writeSync(1,bytes));child.stderr.on('data',bytes=>fs.writeSync(2,bytes))
 const seconds=Number(args.find(a=>a.startsWith('--property=RuntimeMaxSec=')).match(/=(\\d+)s$/)[1])
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}},seconds*1000)
 let exitCode=1
 child.on('exit',(code)=>{clearTimeout(timer);fs.writeFileSync(file,JSON.stringify({pid:0}));exitCode=code??1;setTimeout(()=>process.exit(exitCode),1000)})
 child.on('close',()=>process.exit(exitCode))
}else{
 const unit=args.find(a=>a.startsWith('devpanel-check-')),file=path.join(dir,unit+'.json')
 let entry;try{entry=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
 if(args.includes('stop')){
  if(unit.endsWith('.timer'))fs.rmSync(file,{force:true})
  if(entry?.pid&&alive(entry.pid)){try{process.kill(-entry.pid,'SIGTERM')}catch{};for(let n=0;n<100&&alive(entry.pid);n++)await new Promise(r=>setTimeout(r,20));if(alive(entry.pid))process.exit(1)}
 }else{
  const prop=args[args.indexOf('-p')+1],running=entry?.pid&&alive(entry.pid)
  fs.writeSync(1,(prop==='LoadState'?(entry?'loaded':'not-found'):prop==='ActiveState'?(running?'active':'inactive'):prop==='MainPID'?String(running?entry.pid:0):prop==='InvocationID'?(entry?.invocationId??''):prop==='SubState'?(entry?.timer?'waiting':''):'')+'\\n')
 }
}
`
 for(const name of ['systemd-run','systemctl'])await fs.writeFile(path.join(dir,name),source,{mode:0o755})
 return `export PATH='${dir}':"$PATH"\nexport DEVPANEL_TEST_UNITS='${dir}/units'`
}

/** Play a timer's firing: it leaves the waiting state and its command runs. */
export async function fireTimer (dir, unit) {
 const file = path.join(dir, 'units', `${unit}.timer.json`)
 const { script } = JSON.parse(await fs.readFile(file, 'utf8'))
 await fs.rm(file, { force: true })
 await run('/bin/bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEVPANEL_TEST_UNITS: path.join(dir, 'units') } })
}
