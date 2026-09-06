#!/usr/bin/env bash
set -Eeuo pipefail
[ "${1:-}" = --disposable-host ] || { echo 'Requires an installed disposable host; stages a test patch release.'; exit 2; }
# Run serially after application acceptance. Python/OpenSSL are operator test tools, not platform dependencies.
command -v python3 >/dev/null
mode=${2:-success}
old=$(sed -n 's/^HOTSPARK_VERSION=//p' /etc/hotspark/platform.env)
next=${TEST_TARGET_VERSION:-"${old%.*}.$(( ${old##*.} + 1 ))"}
[[ "$next" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
work=$(mktemp -d /var/lib/hotspark-update-test.XXXXXX)
mkdir -p "$work/source" "$work/releases/v$next"
cp /etc/hotspark/releases.json "$work/original-origin" 2>/dev/null || true
cp /etc/hotspark/release-ca.pem "$work/original-ca" 2>/dev/null || true
server_pid=
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  if [ -f "$work/original-origin" ]; then cp "$work/original-origin" /etc/hotspark/releases.json; else rm -f /etc/hotspark/releases.json; fi
  if [ -f "$work/original-ca" ]; then cp "$work/original-ca" /etc/hotspark/release-ca.pem; else rm -f /etc/hotspark/release-ca.pem; fi
}
trap cleanup EXIT
tar --exclude=node_modules --exclude=.git --exclude=.dev --exclude=dist --exclude=artifacts --exclude='*/.next' -cf - . | tar -xf - -C "$work/source"
docker run --rm -i --user 0:0 -v "$work/source:/work" -w /work "hotspark/api:$old" node --input-type=module - "$next" "$old" "$mode" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const [version,old,mode]=process.argv.slice(2);
for(const path of ['package.json','package-lock.json']){const p=JSON.parse(readFileSync(path,'utf8'));p.version=version;if(p.packages?.[''])p.packages[''].version=version;writeFileSync(path,JSON.stringify(p,null,2)+'\n');}
writeFileSync('release-policy.json',JSON.stringify({version,upgradeFrom:[old],databaseCompatibility:'backward-compatible'}));
if(mode==='fail-health'){const{createRequire}=await import('node:module');const yaml=createRequire('/app/package.json')('yaml');const config=yaml.parse(readFileSync('deployments/compose.yaml','utf8'));config.services.api.healthcheck={test:['CMD','false'],interval:'1s',timeout:'1s',retries:1};writeFileSync('deployments/compose.yaml',yaml.stringify(config));}
JS
# The heredoc requires Docker stdin to be open.
docker run --rm --user 0:0 -v "$work/source:/work" -w /work "hotspark/api:$old" bash scripts/release.sh >/dev/null
cp "$work/source/artifacts/release.json" "$work/source/artifacts/hotspark-$next.tar.gz" "$work/releases/v$next/"
gateway=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=hotspark-release-test' -addext "subjectAltName=IP:$gateway" -keyout "$work/key.pem" -out /etc/hotspark/release-ca.pem >/dev/null 2>&1
printf '{"baseUrl":"https://%s:9443/releases"}\n' "$gateway" > /etc/hotspark/releases.json
python3 - "$work" "$gateway" <<'PY' > "$work/https.log" 2>&1 &
import http.server, ssl, os, sys
os.chdir(sys.argv[1])
server=http.server.HTTPServer((sys.argv[2],9443),http.server.SimpleHTTPRequestHandler)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('/etc/hotspark/release-ca.pem',sys.argv[1]+'/key.pem')
server.socket=ctx.wrap_socket(server.socket,server_side=True)
server.serve_forever()
PY
server_pid=$!
sha=$(cut -d' ' -f1 "$work/source/artifacts/SHA256SUMS")
docker run --rm -i --network host --user 0:0 \
 --mount type=bind,src=/etc/hotspark/secrets/admin_password,dst=/run/secrets/admin_password,readonly \
 "hotspark/api:$old" node --input-type=module - "$old" "$next" "$sha" "$mode" <<'JS'
import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const [old,next,sha256,mode]=process.argv.slice(2),base='http://127.0.0.1:3001/api/v1/';
let token='';async function login(){const r=await fetch(base+'auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@localhost',password:readFileSync('/run/secrets/admin_password','utf8').trim()})});assert.ok(r.ok);token=(await r.json()).token;}
await login();
async function call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(`${path}: ${r.status}`);return r.json();}
const before=await call('projects');
async function complete(id,status){for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,5000));try{const t=await call('system/tasks/'+id);if(['succeeded','failed'].includes(t.status)){assert.equal(t.status,status,JSON.stringify(t));return;}}catch(e){if(e.code==='ERR_ASSERTION')throw e;}}throw Error('update timeout');}
const bad=await call('system/updates','POST',{version:next,sha256:'0'.repeat(64)});await complete(bad.taskId,'failed');
assert.equal((await call('system/doctor')).version,old);console.log('PASS untrusted artifact rejected; old platform remains healthy');
const good=await call('system/updates','POST',{version:next,sha256});await complete(good.taskId,mode==='fail-health'?'failed':'succeeded');
assert.equal((await call('system/doctor')).version,mode==='fail-health'?old:next);
const after=await call('projects');
assert.deepEqual(after.map(p=>[p.id,p.activeDeploymentId,p.desiredState]).sort(),before.map(p=>[p.id,p.activeDeploymentId,p.desiredState]).sort());
console.log(mode==='fail-health'?'PASS failed platform health gate restores prior platform version and preserves applications':'PASS versioned update, migration, health gate, durable completion and unchanged application release/intent');
JS
echo "Update integration passed: source=$old target=$next mode=$mode. Test artifacts retained at $work; release origin restored."
