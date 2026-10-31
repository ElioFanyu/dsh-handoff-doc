// Does a never-resolving whenIdle() stall the handoff past its deadline?
import { apply, CONFIG_DEFAULTS } from '../../lib/index.js'

const t0 = Date.now()
const mark = (s) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] ${s}`)

const agent = {
  id: 'src',
  session: { id:'src', header:{cwd:process.cwd()}, requestContext:()=>({provider:'p',model:'m',contextWindow:1e5}),
    snapshotEvents:()=>[{type:'user/message',seq:1,data:{message:{content:[{type:'text',text:'hi'}]}}},{type:'turn/start',seq:2,data:{}}] },
  whenIdle: () => new Promise(() => {}),   // never resolves
  followup: async () => {},
}
const dst = { id:'dst', session:{id:'dst',header:{cwd:process.cwd()},snapshotEvents:()=>[]}, followup: async()=>{} }
const cmds = []
const ctx = {
  get:(n)=> n==='commands'?{register:(d)=>{cmds.push(d);return()=>{}}}
    : n==='agents'?{get:(id)=>id==='dst'?dst:agent}
    : n==='sessions'?{get:()=>agent.session}
    : n==='llm'?{stream:()=>{mark('llm.stream called');return (async function*(){yield{type:'text-delta',text:'x'};yield{type:'finish',reason:{kind:'stop'}}})()}}
    : n==='sessionController'?{create:async()=>({sessionId:'dst'}),selectModel:async()=>({selected:{provider:'p',model:'m'}})}
    : undefined,
  on:()=>()=>{}, effect:(cb)=>cb(), inject:(_d,cb)=>cb(),
  logger:{info:(m)=>mark('log: '+m),warn:()=>{},error:()=>{}},
}
apply(ctx, { ...CONFIG_DEFAULTS, stepWaitTimeoutMs: 2000, actionDeadlineMs: 5000, archiveSourceAfterHandoff: false })

mark('calling /handoff (stepWait=2s, deadline=5s)')
const timer = setTimeout(() => { mark('*** STILL PENDING after 15s — this is the hang ***'); process.exit(2) }, 15000)
const r = await cmds[0].handler({ agent, rawInput: '' })
clearTimeout(timer)
mark('returned: ' + r.kind)
console.log(r.text.split('\n')[0])
process.exit(0)
