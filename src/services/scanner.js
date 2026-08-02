import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CAMERA_PORTS = [80, 443, 554, 8000];

export function listInterfaces() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) => (entries || [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => ({
        name,
        address: entry.address,
        netmask: entry.netmask,
        cidr: `${entry.address}/24`
      })));
}

export async function scanSubnet(cidr, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 350);
  const limit = Math.min(Number(options.limit || 254), 254);
  const base = cidrToBase(cidr);
  const hosts = Array.from({ length: limit }, (_, index) => `${base}.${index + 1}`);
  const results = [];

  await runPool(hosts, 48, async (host) => {
    const openPorts = [];
    await Promise.all(CAMERA_PORTS.map(async (port) => {
      if (await isPortOpen(host, port, timeoutMs)) {
        openPorts.push(port);
      }
    }));
    if (openPorts.length > 0) {
      const macAddress = await lookupMacAddress(host);
      results.push({
        ipAddress: host,
        macAddress,
        openPorts: openPorts.sort((a, b) => a - b),
        sdkPort: openPorts.includes(8000) ? 8000 : "",
        webUrl: openPorts.includes(443) ? `https://${host}` : openPorts.includes(80) ? `http://${host}` : "",
        confidence: openPorts.includes(8000) || openPorts.includes(554) ? "high" : "medium"
      });
    }
  });

  return results.sort((a, b) => ipToNumber(a.ipAddress) - ipToNumber(b.ipAddress));
}

async function lookupMacAddress(host) {
  try {
    const { stdout } = await execFileAsync("arp", ["-n", host], { timeout: 800 });
    const match = stdout.match(/(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i);
    return match ? normalizeMac(match[0]) : "";
  } catch {
    return "";
  }
}

function normalizeMac(mac) {
  return mac.split(":").map((part) => part.padStart(2, "0").toUpperCase()).join(":");
}

function cidrToBase(cidr) {
  const ip = String(cidr || "").split("/")[0];
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error("CIDR must look like 192.168.1.0/24");
  }
  return parts.slice(0, 3).join(".");
}

function ipToNumber(ip) {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}
