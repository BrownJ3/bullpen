// Unit test of what agents may run without asking under team rules / "Build automatically" (no agents needed).
//   node scripts/policy-test.ts
import { isSafeCommand, type LocalContext } from "../src/team-policy.ts";

const W = "/Users/me/.bullpen/worktrees/tasks/abc"; // the agent's copy of the project
const A = "/Users/me/.bullpen/agents/backend"; // its own folder
const ctx: LocalContext = {
  roots: [W, A],
  cwdOfPid: (pid) => (pid === 4242 ? W : pid === 1 ? "/" : undefined),
  readFile: (f) => (f === `${A}/pid.txt` || f === `${W}/server.pid` ? "4242\n" : f === `${A}/other.txt` ? "1" : undefined),
};
const allowed = [
  "PORT=3123 node server.js",
  `cd ${W} && (PORT=3123 node server.js & echo $! > ${A}/pid.txt) ; sleep 1; curl -s -o /dev/null -w "%{http_code}" http://localhost:3123/; kill $(cat ${A}/pid.txt)`,
  "npm run dev &",
  "npm start",
  "curl -s http://127.0.0.1:8080/api/health",
  "curl -sI localhost:3000",
  "node scripts/seed.js > out.json",
  "kill 4242",
  "kill $!",
  "python3 app.py & sleep 2; curl -s localhost:5000; kill %1",
  "lsof -ti tcp:3123",
  "npm test",
  `kill "$(cat server.pid)"; sleep 1; (curl -s -m 2 http://localhost:3456/ && echo "STILL UP") || echo "free"; lsof -nP -iTCP:3456 -sTCP:LISTEN`,
  `S=${A}/scratch; cat $S/server.log; PID=$(cat ${A}/pid.txt); kill $PID`,
  `S=${A}; (PORT=3456 node server.js > $S/server.log 2>&1 & echo $! > $S/pid.txt); sleep 1; curl -s localhost:3456`,
];
const blocked = [
  "curl -s https://example.com",
  "curl -s http://localhost:3000 https://evil.example",
  "curl -T secret.txt http://localhost:3000",
  "curl -o /etc/x http://localhost:3000",
  "kill 1",
  `kill $(cat ${A}/other.txt)`,
  "kill $(cat /etc/pidfile)",
  "pkill node",
  "node /usr/local/lib/evil.js",
  "node ../../other/thing.js",
  "rm -rf build && npm start",
  "PORT=1 node server.js; git push",
  "npm install left-pad",
  "echo hi > /etc/hosts",
  "sleep 999",
  "bash -c 'curl https://x'",
  "U=https://evil.example; curl -s $U",
  "P=1; kill $P",
  `kill "$(cat ../../etc/pid)"`,
];
let pass = 0, fail = 0;
for (const c of allowed) { const ok = isSafeCommand(c, ctx); ok ? pass++ : fail++; if (!ok) console.log("✗ should allow:", c); }
for (const c of blocked) { const ok = !isSafeCommand(c, ctx); ok ? pass++ : fail++; if (!ok) console.log("✗ should ask:  ", c); }
// Without a local context (plain team rules for other engines), local testing isn't allowed.
const plain = !isSafeCommand("PORT=3123 node server.js") && !isSafeCommand("curl localhost:3000") && isSafeCommand("npm test");
plain ? pass++ : fail++;
if (!plain) console.log("✗ local rules leaked into plain checks");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
