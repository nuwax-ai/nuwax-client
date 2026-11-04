import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createModelBroker } from '../model-broker.mjs'
const execute = promisify(execFile)
const home = resolve(process.argv[2] ?? join(tmpdir(), 'nuwax-dsh-voice-acceptance'))
await mkdir(home, { recursive: true })
const models = [{ id: '1', provider: 'nuwax-1', name: 'Fixture', model: 'fixture', api: 'openai-completions', input: ['text'], contextWindow: 128000, maxTokens: 8192 }]
const broker = createModelBroker({ models, baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', current: () => true, port: 0 })
const base = await broker.start()
await writeFile(join(home, 'launch.json'), JSON.stringify({ models, workspace: join(home, 'workspace'), port: 0 }))
let output = '', id = 0
const child = fork(fileURLToPath(new URL('./plugin-driver.mjs', import.meta.url)), [], { env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, NUWAX_DSH_SCOPE_ROOT: home, NUWAX_DSH_BROKER: base, NUWAX_DSH_RUN_TOKEN: broker.token, NUWAX_DSH_OFFICE: resolve('../agent-electron-client/resources/dsh-office'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
child.stdout.on('data', value => { output = (output + value).slice(-12000) }); child.stderr.on('data', value => { output = (output + value).slice(-12000) })
async function action(action, fields = {}) {
 const requestId = ++id
 return new Promise((resolve,reject) => { const timer = setTimeout(()=>reject(new Error('Voice operation timed out')),120000); const listener=message=>{if(message.type!=='plugin-result'||message.id!==requestId)return;clearTimeout(timer);child.off('message',listener);message.error?reject(new Error(message.error)):resolve(message.value)}; child.on('message',listener);child.send({type:'plugin-test',id:requestId,action,...fields}) })
}
async function state() { return (await action('voice-state')).providers.find(value=>value.id==='sensevoice-local').preparation }
let audio
try {
 await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error(output)),45000);child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve()}if(message.type==='failed'){clearTimeout(timer);reject(new Error(message.error+'\n'+output))}}) })
 await action('voice-prepare'); await action('voice-cancel')
 assert.ok(['cancelled','ready','standby'].includes((await state()).phase))
 await action('voice-prepare')
 const deadline=Date.now()+10*60*1000
 let last
 while(Date.now()<deadline){const value=await state();const text=JSON.stringify(value);if(text!==last){console.log(text);last=text}if(['ready','standby'].includes(value.phase))break;if(value.phase==='failed')throw new Error(value.message);await new Promise(resolve=>setTimeout(resolve,1000))}
 assert.ok(['ready','standby'].includes((await state()).phase),'voice resources never became ready')
 if(process.platform==='darwin'){
   audio=await mkdtemp(join(tmpdir(),'nuwax-dsh-voice-input-'))
   await execute('say',['-o',join(audio,'spoken.aiff'),'This is a voice integration test.'])
   await execute('afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',join(audio,'spoken.aiff'),join(audio,'spoken.wav')])
   const wav=await readFile(join(audio,'spoken.wav'));let offset=12,data;while(offset+8<=wav.length){const size=wav.readUInt32LE(offset+4);if(wav.toString('ascii',offset,offset+4)==='data'){data=wav.subarray(offset+8,offset+8+size);break;}offset+=8+size+(size%2);}assert.ok(data);
   const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);await writeFile(join(audio,'spoken.wav'),Buffer.concat([header,data]));
   const transcript=await action('voice-transcribe',{file:join(audio,'spoken.wav')})
   assert.match(transcript.text,/voice|test/i)
   console.log(JSON.stringify({level:'native-sensevoice-with-system-generated-audio',cancel:true,retry:true,text:transcript.text,audioSeconds:transcript.audioSeconds}))
 } else console.log(JSON.stringify({level:'native-sensevoice-model-preparation',cancel:true,retry:true,ready:true}))
} finally {
 const stopped = child.exitCode === null ? new Promise(resolve=>child.once('exit',resolve)) : Promise.resolve()
 if(child.connected)child.send({type:'stop'},()=>{})
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await stopped;clearTimeout(timer);await broker.close();if(audio)await rm(audio,{recursive:true,force:true})
}
