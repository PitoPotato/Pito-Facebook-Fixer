import {readFile} from 'node:fs/promises';
const control=JSON.parse(await readFile('test-results/live-qa-0.3.0/control.json','utf8'));
const [op,value]=process.argv.slice(2);const command={op};
if(op==='adopt')command.text=value;
if(op==='media-unsend')command.kind=value;
if(['menu','choose','confirm','vault'].includes(op))command.name=value;
const response=await fetch(`http://127.0.0.1:${control.port}/`,{method:'POST',headers:{'content-type':'application/json','x-pff-qa-key':control.key},body:JSON.stringify(command),signal:AbortSignal.timeout(45000)});
const result=await response.json();console.log(JSON.stringify(result,null,2));
if(!result.ok)process.exitCode=1;
