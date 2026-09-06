import {createHash} from 'node:crypto';
import {applicationSpecSchema,projectIdSchema,type ApplicationSpec,type ServiceSpec,type WebServiceSpec} from '../../application-spec/src/index.js';
export const catalog={
 node:{'22':'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5','24':'node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'},
 postgres:{'16':'postgres:16-bookworm@sha256:bb3e1a57e5407e0a5280b4211980a5e537f4abd234a87014ac979849a78dd825','17':'postgres:17.7-bookworm@sha256:86e0b703649d7a792bd9243ee28afc9d8f7c6b2b5638077c9d6882d4d472bbfd','18':'postgres:18-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af'},
 nginx:'nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6',
};
export function resourceName(projectId:string,service:string){projectIdSchema.parse(projectId);return `s-${createHash('sha256').update(`${projectId}:${service}`).digest('hex').slice(0,16)}`;}
export interface PlannedService {name:string;id:string;type:ServiceSpec['type'];image:string;alias:string;port?:number;database?:{service:string;host:string;name:string;user:string};volume?:string;spec:ServiceSpec}
export interface BuildPlan {service:string;id:string;repository:string;commit:string;image:string;dockerfile:string|null;files:Record<string,string>}
export interface DeploymentPlan {version:2;projectId:string;composeProject:string;spec:ApplicationSpec;specHash:string;services:PlannedService[];builds:BuildPlan[]}
export interface Provider {build:(s:WebServiceSpec)=>{dockerfile:string;files:Record<string,string>}}
const runtimeLoader=`import {readFileSync} from 'node:fs';\nimport {spawn} from 'node:child_process';\nconst config=JSON.parse(readFileSync('/opt/hotspark/start.json','utf8'));\nlet env={...process.env};\nif(process.env.HOTSPARK_ENV_FILE)Object.assign(env,JSON.parse(readFileSync(process.env.HOTSPARK_ENV_FILE,'utf8')));\nconst args=process.argv.includes('--migrate')?['./node_modules/prisma/build/index.js','migrate','deploy']:config.slice(1);\nconst cmd=process.argv.includes('--migrate')?'node':config[0];\nconst child=spawn(cmd,args,{stdio:'inherit',env,...(process.argv.includes('--migrate')?{cwd:'/app'}:{})});\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>process.exit(1));\nchild.on('exit',(code)=>process.exit(code??1));\n`;
function nodeBuild(s:WebServiceSpec,react=false){
 const pm=s.build.packageManager;
 const install=s.build.installCommand??(pm==='npm'?['npm','ci']:pm==='pnpm'?['pnpm','install','--frozen-lockfile']:['yarn','install','--immutable']);
 const build=s.build.buildCommand??[pm,'run','build'];
 const start=s.build.startCommand??(s.type==='nextjs'&&s.build.standalone?['node','server.js']:[pm,'run','start']);
 const bootstrap=pm==='npm'?'':`RUN npm install --global ${pm==='pnpm'?'pnpm@10.17.1':'corepack@0.34.1'}${pm==='yarn'?' && corepack enable && corepack prepare yarn@4.9.2 --activate':''}\n`;
 const files:Record<string,string>={'loader.mjs':runtimeLoader,'start.json':JSON.stringify(start)};
 let dockerfile=`FROM ${catalog.node[s.build.nodeVersion]} AS build\nWORKDIR /app\nRUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*\n${bootstrap}COPY --from=source / /app/\nRUN ${JSON.stringify(install)}\nRUN ${JSON.stringify(build)}\n`;
 if(react){
  files['nginx.conf']=`server { listen 8080; server_name _; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }\n`;
  dockerfile+=`FROM ${catalog.nginx}\nCOPY --from=build /app/${s.build.outputDirectory}/ /usr/share/nginx/html/\nCOPY nginx.conf /etc/nginx/conf.d/default.conf\nUSER 10001:10001\nEXPOSE 8080\n`;
 }else{
  if(s.type==='nextjs'&&s.build.standalone){
   dockerfile+='RUN test -f .next/standalone/server.js && mkdir -p .next/standalone/.next && cp -r .next/static .next/standalone/.next/static && if [ -d public ]; then cp -r public .next/standalone/public; fi\n';
  }
  // Full dependency tree retained for controlled Prisma hooks; standalone runtime uses its traced tree.
  dockerfile+=`FROM build AS runtime\nCOPY loader.mjs /opt/hotspark/loader.mjs\nCOPY start.json /opt/hotspark/start.json\n${s.type==='nextjs'&&s.build.standalone?'WORKDIR /app/.next/standalone\n':''}ENV NODE_ENV=production HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1\nUSER 10001:10001\nENTRYPOINT ["node","/opt/hotspark/loader.mjs"]\n`;
 }
 return {dockerfile,files};
}
export const providers:Record<'nextjs'|'node'|'react',Provider>={nextjs:{build:s=>nodeBuild(s)},node:{build:s=>nodeBuild(s)},react:{build:s=>nodeBuild(s,true)}};
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
export function stableHash(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function planDeployment(projectId:string,input:unknown):DeploymentPlan{
 projectIdSchema.parse(projectId);const spec=applicationSpecSchema.parse(input);const specHash=stableHash(spec);const composeProject=`hs-${projectId}`;const builds:BuildPlan[]=[];
 const services=Object.entries(spec.services).sort(([a],[b])=>a.localeCompare(b)).map(([name,s]):PlannedService=>{
  const id=resourceName(projectId,name),alias=`${composeProject}-${id}`;
  if(s.type==='postgres')return {name,id,alias,type:s.type,image:s.image??catalog.postgres[s.version],volume:`${id}-data`,database:{service:name,host:id,name:`db_${id.slice(2)}`,user:`u_${id.slice(2)}`},spec:s};
  const image=s.source.type==='image'?s.source.image:`hotspark/${projectId}/${id}:${specHash.slice(0,32)}`;
  if(s.source.type==='git'){const template=s.type==='web'?{dockerfile:null,files:{}}:providers[s.type].build(s);builds.push({service:name,id,repository:s.source.repository,commit:s.source.commit,image,...template});}
  const database=s.database?{service:s.database,host:resourceName(projectId,s.database),name:`db_${resourceName(projectId,s.database).slice(2)}`,user:`u_${resourceName(projectId,s.database).slice(2)}`}:undefined;
  return {name,id,alias,type:s.type,image,port:s.type==='react'?8080:s.runtime.port,spec:s,...(database?{database}:{})};
 });return {version:2,projectId,composeProject,spec,specHash,services,builds};
}
