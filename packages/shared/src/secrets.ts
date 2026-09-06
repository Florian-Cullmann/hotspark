import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
export function seal(value:unknown,key:string,context:string){
 if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid encryption key');
 const nonce=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),nonce);cipher.setAAD(Buffer.from(context));
 const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return ['v1',nonce.toString('base64url'),cipher.getAuthTag().toString('base64url'),data.toString('base64url')].join('.');
}
export function unseal<T>(value:string,key:string,context:string):T{
 const [version,nonce,tag,data]=value.split('.');if(version!=='v1'||!nonce||!tag||!data)throw new Error('Invalid encrypted value');
 const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(nonce,'base64url'));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(Buffer.from(tag,'base64url'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString('utf8')) as T;
}
export function redact(value:string,secrets:string[]){let out=value.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi,'[REDACTED_DATABASE_URL]');for(const s of [...new Set(secrets)].filter(Boolean).sort((a,b)=>b.length-a.length))out=out.split(s).join('[REDACTED]');return out;}
