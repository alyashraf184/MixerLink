const { spawn } = require("node:child_process");
const net = require("node:net");

const vitePort = 5173;
const devServerUrl = `http://127.0.0.1:${vitePort}`;
const processes = [];

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    shell: true,
    stdio: "inherit",
    ...options
  });
  processes.push(child);
  return child;
}

function waitForPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tryConnect = () => {
      const socket = net.createConnection({ port, host }, () => {
        socket.end();
        resolve();
      });

      socket.on("error", () => {
        setTimeout(tryConnect, 120);
      });
    };

    tryConnect();
  });
}

function shutdown() {
  for (const child of processes) {
    child.kill();
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

spawnProcess("npm.cmd", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort)]);

waitForPort(vitePort).then(() => {
  spawnProcess("electron.cmd", ["."], {
    env: {
      ...process.env,
      MIXERLINK_DEV_SERVER_URL: devServerUrl
    }
  });
});
