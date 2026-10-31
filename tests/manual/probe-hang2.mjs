// The reported symptom: 10 minutes, only a banner printed.
// Test each phase separately against the BUILT lib.
import { apply, CONFIG_DEFAULTS } from '../../lib/index.js'

async function run(label, opts) {
  const t0 = Date.now()
  const mark = (s) => console.log(`  [+${((Date.now()-t0)/1000).toFixed(1)}s] ${s}`)
  const agent = {
    id:'src',
    session:{ id:'src', header:{cwd:process.cwd()}, requestContext:()=>({provider:'p',model:'m',contextWindow:1e5}),
      snapshotEvents:()=>[{type:'user/message',seq:1,data:{message:{content:[{type:'text',text:'hi'}]}}},{type:'turn/start',seq:2,data:{}}] },
    whenIdle: opts.idle,
    followup: async()=>{},
  }
  const dst={id:'dst',session:{id:'dst',header:{cwd:process.cwd()},snapshotEvents:()=>[]},followup:async()=>{}}
  const cmds=[]
  const ctx={
    get:(n)=> n==='commands'?{register:(d)=>{cmds.push(d);return()=>{}}}
      : n==='agents'?{get:(id)=>id==='dst'?dst:agent}
      : n==='sessions'?{get:()=>agent.session}
      : n==='llm'?{stream:()=>{mark('llm.stream called');return opts.stream(mark)}}
      : n==='sessionController'?{create:async()=>({sessionId:'dst'}),selectModel:async()=>({selected:{provider:'p',model:'m'}})}
      : undefined,
    on:()=>()=>{}, effect:(cb)=>cb(), inject:(_d,cb)=>cb(),
    logger:{info:(m)=>mark('log: '+m),warn:()=>{},error:()=>{}},
  }
  apply(ctx,{...CONFIG_DEFAULTS, stepWaitTimeoutMs:2000, actionDeadlineMs:5000, summaryMaxTokens:4000, archiveSourceAfterHandoff:false})
  console.log(`\n=== ${label} ===`)
  mark('calling /handoff')
  let done=false
  const guard = setTimeout(()=>{ if(!done) mark('*** STILL PENDING at 12s ***') }, 12000)
  const r = await cmds[0].handler({agent, rawInput:''})
  done=true; clearTimeout(guard)
  mark('returned: '+r.kind)
  console.log('  ' + r.text.split('\n')[0].slice(0,120))
}

await run('1. llm stream never sends finish', { idle: () => Promise.resolve(), stream: () => (async function*(){ yield {type:'text-delta',text:'x'}; await new Promise(()=>{}) })() })
await run('2. llm stream throws immediately', { idle: () => Promise.resolve(), stream: () => (async function*(){ throw new Error('boom') })() })
await run('3. llm.stream is not a function', { idle: () => Promise.resolve(), stream: undefined })
await run('4. whenIdle rejects', { idle: () => Promise.reject(new Error('idle failed')), stream: () => (async function*(){yield{type:'text-delta',text:'x'};yield{type:'finish',reason:{kind:'stop'}}})() })
process.exit(0)
