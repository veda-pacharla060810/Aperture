import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['index.js'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

let ready = false;
server.stdout.on('data', (d) => {
  process.stdout.write('[server] ' + d);
  if (d.toString().includes('listening')) ready = true;
});
server.stderr.on('data', (d) => process.stdout.write('[server-err] ' + d));

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  for (let i = 0; i < 20 && !ready; i++) await wait(200);
  if (!ready) { console.log('server did not start in time'); server.kill(); process.exit(1); }

  const health = await fetch('http://localhost:3001/');
  console.log('health:', await health.text());

  const resp = await fetch('http://localhost:3001/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'github.com' })
  });
  const json = await resp.json();
  console.log('analyze status:', resp.status);
  console.log(JSON.stringify(json, null, 2));

  server.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
