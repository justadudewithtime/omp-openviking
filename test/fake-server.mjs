/**
 * Fake OpenViking server for the lifecycle harness. Serves a health answer
 * with a version field (what the adapter requires for identity) and spawns
 * one child process, so tests can prove taskkill /T takes the tree down.
 * FAKE_UP and FAKE_CHILD lines go to stdout, which the adapter redirects to
 * server.log in the endpoint's state dir.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number(process.env.FAKE_PORT || 2933);

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
console.log("FAKE_CHILD", child.pid);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "fake" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
}).listen(port, "127.0.0.1", () => console.log("FAKE_UP", process.pid));
