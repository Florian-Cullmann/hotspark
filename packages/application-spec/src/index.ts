import { z } from "zod";
export const nameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const projectIdSchema = z.string().uuid();
export const domainSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const imageSchema = z.string().max(512).regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const envNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(v=>!['NODE_OPTIONS','LD_PRELOAD','LD_LIBRARY_PATH','PATH','HOME','NODE_ENV','PORT','HOSTNAME','DATABASE_URL','HOTSPARK_ENV_FILE'].includes(v),'Reserved environment variable');
export const environmentSchema = z.record(envNameSchema,z.string().max(8192)).refine(v=>Object.keys(v).length<=100,'At most 100 variables');
export const secretInputSchema=z.record(nameSchema,z.record(envNameSchema,z.string().min(1).max(8192))).default({});
const sourceSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('image'),image:imageSchema}).strict(),
 z.object({type:z.literal('git'),repository:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/),commit:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
]);
// Commands are argv, never shell strings. Build/start scripts execute only inside build/workload containers.
export const commandSchema=z.array(z.string().min(1).max(256).regex(/^[A-Za-z0-9_./:@=,+-]+$/)).min(1).max(24).refine(a=>['npm','pnpm','yarn','node','npx'].includes(a[0]!), 'Use a supported Node/package-manager executable');
const resourcesSchema=z.object({memoryMb:z.number().int().min(64).max(8192).default(512),cpus:z.number().min(.1).max(8).default(1)}).strict().default({memoryMb:512,cpus:1});
const webSchema=z.object({
 type:z.enum(['web','nextjs','node','react']),source:sourceSchema,
 runtime:z.object({port:z.number().int().min(1024).max(65535).default(3000),healthPath:z.string().max(200).regex(/^\/[a-zA-Z0-9/_-]*$/).default('/'),readOnly:z.boolean().default(true)}).strict().default({port:3000,healthPath:'/',readOnly:true}),
 build:z.object({nodeVersion:z.enum(['22','24']).default('24'),packageManager:z.enum(['npm','pnpm','yarn']).default('npm'),installCommand:commandSchema.optional(),buildCommand:commandSchema.optional(),startCommand:commandSchema.optional(),outputDirectory:z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).default('dist'),standalone:z.boolean().default(false)}).strict().default({nodeVersion:'24',packageManager:'npm',outputDirectory:'dist',standalone:false}),
 environment:environmentSchema.default({}),secrets:z.array(envNameSchema).max(100).default([]),database:nameSchema.optional(),
 hooks:z.array(z.object({type:z.literal('prisma-migrate-deploy')}).strict()).max(1).default([]),
 domains:z.array(domainSchema).max(10).default([]),resources:resourcesSchema,
}).strict().superRefine((s,ctx)=>{
 if(s.build.startCommand?.some(v=>['dev','--watch','--hot','vite','nodemon'].includes(v)))ctx.addIssue({code:'custom',message:'Development servers are not permitted'});
 if(s.type==='react'&&(s.database||s.secrets.length||s.hooks.length))ctx.addIssue({code:'custom',message:'Static applications cannot receive runtime secrets/database connections/hooks'});
 if(s.hooks.length&&!s.database)ctx.addIssue({code:'custom',message:'Prisma hook requires a database connection'});
 if(s.type==='web'&&(s.database||s.secrets.length||s.hooks.length))ctx.addIssue({code:'custom',message:'Legacy Dockerfile/image provider cannot receive secrets; use a managed Node provider'});
 if(s.source.type==='image'&&(s.database||s.secrets.length||s.hooks.length))ctx.addIssue({code:'custom',message:'Secret injection requires a managed Git build'});
 if(new Set(s.secrets).size!==s.secrets.length||s.secrets.some(k=>k in s.environment))ctx.addIssue({code:'custom',message:'Environment and secret names must be distinct'});
});
const postgresSchema=z.object({type:z.literal('postgres'),version:z.enum(['16','17','18']).default('17'),image:imageSchema.optional(),resources:resourcesSchema}).strict().superRefine((s,ctx)=>{if(s.image&&!s.image.startsWith(`postgres:${s.version}@sha256:`))ctx.addIssue({code:'custom',message:'Postgres image must match its selected official major version'});});
export const applicationSpecSchema=z.object({apiVersion:z.literal('hotspark.dev/v1'),kind:z.literal('Application'),metadata:z.object({name:nameSchema}).strict(),services:z.record(nameSchema,z.union([webSchema,postgresSchema])).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=20,'Provide 1–20 services')}).strict().superRefine((spec,ctx)=>{
 const domains=Object.values(spec.services).flatMap(s=>'domains'in s?s.domains:[]);
 if(new Set(domains).size!==domains.length)ctx.addIssue({code:'custom',message:'Domains must be unique'});
 for(const [name,s]of Object.entries(spec.services))if(s.type!=='postgres'&&s.database&&spec.services[s.database]?.type!=='postgres')ctx.addIssue({code:'custom',path:['services',name,'database'],message:'Connection must reference a PostgreSQL service in this project'});
});
export type ApplicationSpec=z.infer<typeof applicationSpecSchema>;
export type ServiceSpec=ApplicationSpec['services'][string];
export type WebServiceSpec=Exclude<ServiceSpec,{type:'postgres'}>;
export const createProjectSchema=z.object({spec:applicationSpecSchema,secrets:secretInputSchema}).strict();
export const patchProjectSchema=z.object({spec:applicationSpecSchema.optional(),secrets:secretInputSchema,restoreOnDrift:z.boolean().optional()}).strict();
export const lifecycleStates=['created','provisioning','building','running','degraded','failed','stopped','deleting','deleted'] as const;
export const desiredStates=['running','stopped','deleted'] as const;
const projectOp={projectId:projectIdSchema};
const mutation={...projectOp,operationId:z.string().uuid()};
export const operationSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('deploy'),...mutation,deploymentId:z.string().uuid(),spec:applicationSpecSchema,encryptedSecrets:z.string().max(400000).optional()}).strict(),
 ...(['start','stop','restart','remove']as const).map(operation=>z.object({operation:z.literal(operation),...mutation}).strict()),
 z.object({operation:z.literal('inspect'),...projectOp}).strict(),
 z.object({operation:z.literal('logs'),...projectOp,service:nameSchema,lines:z.number().int().min(1).max(1000).default(100),stream:z.enum(['stdout','stderr','both']).default('both')}).strict(),
 z.object({operation:z.literal('host-info')}).strict(),
 z.object({operation:z.literal('operation-status'),operationId:z.string().uuid()}).strict(),
]);
export type AgentOperation=z.infer<typeof operationSchema>;
export const applicationSpecJsonSchema=z.toJSONSchema(applicationSpecSchema,{target:'draft-7',io:'input'});
// The pure compiler is exported here for existing SDK consumers.
export {planDeployment} from '../../providers/src/index.js';
export type {DeploymentPlan} from '../../providers/src/index.js';
