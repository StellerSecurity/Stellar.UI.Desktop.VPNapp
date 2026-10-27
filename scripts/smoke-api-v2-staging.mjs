// Only the isolated fixture host; never accepts production URLs or real credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base='https://stellar-desktop-vpn-staging-ayakcqbcfvb2fqhc.westeurope-01.azurewebsites.net';
const checks=[];
async function request(route,status,options={}){
 const response=await fetch(base+route,{...options,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Accept:'application/json',...options.headers}});
 assert.equal(response.status,status,`${route} status`);
 const body=await response.text();
 assert(!body.includes('Stellar\\DesktopApi')&&!body.includes('Stack trace:')&&!body.includes('vendor/laravel'),`${route} exception leak`);
 if(response.headers.get('content-type')?.includes('application/json')){
  const json=JSON.parse(body);
  assert.equal(json.meta.mode,'fixture');
  assert.equal(json.meta.api_version,'v2');
  assert.equal(response.headers.get('x-request-id'),json.meta.request_id);
  assert.match(response.headers.get('cache-control'),/no-store/);
  checks.push({route,status,format:'json'});
  return json;
 }
 assert.equal(status,404,'Only nginx-denied paths may return non-JSON');
 checks.push({route,status,format:'nginx-denial'});
}
try{
 const health=await request('/api/v2/health',200);
 assert.deepEqual(health.data,{status:'ok',ready:false,vpn_connected:false});
 const servers=await request('/api/v2/servers',200);
 assert.equal(servers.data.length,58);
 assert.equal(new Set(servers.data.map(s=>s.id)).size,58);
 const dk=await request('/api/v2/servers?country=DK',200);
 assert(dk.data.length>0&&dk.data.every(s=>s.country_code==='DK'));
 await request('/api/v2/servers?country=invalid',422);
 for(const route of ['/.env','/composer.json','/composer.lock','/vendor/composer/installed.json','/vendor/autoload.php','/deploy/azure/startup.sh','/fixtures/servers.json','/api/v1/vpncontroller/server-list'])await request(route,404);
 // Invalid, synthetic credentials only: this must reach User API and be rejected,
 // not create an account/session or touch a real user's data.
 const login=await request('/api/v2/auth/login',401,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'stellar-integration-probe-20261027@example.invalid',password:'synthetic-invalid-probe-password'})});
 assert.equal(login.error.code,'invalid_credentials');
 assert(!('data' in login));
 const logout=await request('/api/v2/auth/logout',401,{method:'POST',headers:{Authorization:'Bearer fake-staging-probe-not-a-token'}});
 assert.equal(logout.error.code,'invalid_session');
 await request('/api/v2/auth/register',422,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'invalid',password:'short'})});
 const cors=await fetch(base+'/api/v2/auth/login',{method:'OPTIONS',redirect:'error',headers:{Origin:'tauri://localhost','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'},signal:AbortSignal.timeout(45000)});
 assert.equal(cors.headers.get('access-control-allow-origin'),'tauri://localhost');
 console.log(`${checks.length} staging HTTP scenarios passed; 58 fixtures; upstream login rejection and desktop CORS verified. No real accounts used or created.`);
 fs.writeFileSync('.security-review/api-v2-staging-smoke.json',JSON.stringify({date:new Date().toISOString(),base,passed:true,checks,fixtureLocations:58},null,2));
}catch(error){
 fs.writeFileSync('.security-review/api-v2-staging-smoke.json',JSON.stringify({date:new Date().toISOString(),base,passed:false,checks,error:error.message},null,2));
 console.error(error.message);process.exitCode=1;
}
