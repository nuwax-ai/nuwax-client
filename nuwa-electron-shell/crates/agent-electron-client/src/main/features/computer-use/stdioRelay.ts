/** The relay owns only protocol connectivity. It never starts a helper or replays an action. */
export const CUA_STDIO_RELAY = String.raw`
const fs=require('node:fs'),net=require('node:net'),crypto=require('node:crypto');
const input=require('node:readline').createInterface({input:process.stdin});
let socket,ready=false,ended=false,timer,attempt=0,buffer='',initialization,initializedResult,toolsResult,restoreId;
const pending=new Map();
const key=id=>typeof id+':'+String(id);
const emit=m=>{if(!process.stdout.write(JSON.stringify(m)+'\n'))socket?.pause();};
process.stdout.on('drain',()=>socket?.resume());
const reject=m=>{if(m.id===undefined)return;emit(m.method==='tools/call'
 ?{jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'Computer Use: serviceRecovering. Connection interrupted; an action may already have taken effect. Do not replay it. Observe again after recovery.'}],structuredContent:{code:'serviceRecovering',retryable:false}}}
 :{jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Computer Use: serviceRecovering'}});};
function send(m){if(m.id!==undefined)pending.set(key(m.id),m);if(!socket.write(JSON.stringify(m)+'\n'))input.pause();}
function connect(){
 if(ended)return;
 const s=net.connect(process.env.NUWAX_CUA_GATEWAY);socket=s;s.setEncoding('utf8');buffer='';ready=false;
 s.on('drain',()=>input.resume());
 s.on('connect',()=>{
  try{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_CUA_GATEWAY_TOKEN,'utf8').trim(),grant:process.env.NUWAX_CUA_SESSION_FILE?fs.readFileSync(process.env.NUWAX_CUA_SESSION_FILE,'utf8').trim():undefined})+'\n');}
  catch{s.destroy();return;}
  if(initialization){restoreId='relay-initialize-'+crypto.randomUUID();s.write(JSON.stringify({...initialization,id:restoreId})+'\n');}
  else ready=true;
 });
 s.on('data',chunk=>{
  if(socket!==s)return;
  buffer+=chunk;if(Buffer.byteLength(buffer)>32*1024*1024){s.destroy();return;}
  while(buffer.includes('\n')){
   const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   let m;try{m=JSON.parse(line);}catch{s.destroy();return;}
   if(restoreId!==undefined&&m.id===restoreId){
    restoreId=undefined;
    if(m.error){s.destroy();return;}
    initializedResult=m.result;toolsResult=undefined;ready=true;attempt=0;s.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    emit({jsonrpc:'2.0',method:'notifications/tools/list_changed'});
    const init=initialization&&pending.get(key(initialization.id));
    if(init){pending.delete(key(init.id));emit({...m,id:init.id});}
    continue;
   }
   const request=pending.get(key(m.id));
   if(request){pending.delete(key(m.id));if(request.method==='initialize'&&!m.error){initializedResult=m.result;attempt=0;}if(request.method==='tools/list'&&!m.error)toolsResult=m.result;}
   if(m.method==='notifications/tools/list_changed')toolsResult=undefined;
   if(request||m.method)emit(m);
  }
 });
 s.on('error',()=>s.destroy());
 s.on('close',()=>{
  if(socket!==s)return;ready=false;restoreId=undefined;input.resume();
  for(const [id,m] of pending){if(m.method==='initialize'&&!initializedResult)continue;pending.delete(id);reject(m);}
  if(!ended){const delays=[1000,2000,5000];timer=setTimeout(connect,delays[attempt++]??60000);}
 });
 s.setTimeout(15000,()=>{if(!ready)s.destroy();});
}
input.on('line',line=>{
 if(Buffer.byteLength(line)>1024*1024){process.exitCode=1;input.close();return;}
 let m;try{m=JSON.parse(line);}catch{process.exitCode=1;input.close();return;}
 if(m.method==='initialize'){
  initialization=m;
  if(initializedResult){emit({jsonrpc:'2.0',id:m.id,result:initializedResult});return;}
  if(!ready){pending.set(key(m.id),m);return;}
 }
 if(m.method==='tools/list'&&toolsResult&&!ready){emit({jsonrpc:'2.0',id:m.id,result:toolsResult});return;}
 if(m.method==='ping'){emit({jsonrpc:'2.0',id:m.id,result:{}});return;}
 if(!ready){reject(m);return;}
 send(m);
});
input.on('close',()=>{ended=true;clearTimeout(timer);socket?.destroy();});
connect();
`;
