// Using Bullpen from another device (T3: LAN / Tailscale / SSH tunnel). Off by default.
//
// `bullpen remote on` makes the server also listen on this Mac's Tailscale address (encrypted, only your devices),
// or with --lan on its local-network address (plain HTTP: only on a network you trust). Other devices connect with
// their own token, separate from this Mac's, so `bullpen remote off` or `bullpen remote reset` cuts them off
// without touching anything local. Over SSH, nothing needs turning on: forward the port (see sshCommand()).

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { HOME, ensureHome } from "./home.ts";

const CONFIG = join(HOME, "remote.json");
const DEVICE_TOKEN = join(HOME, "device-token");

export interface RemoteConfig {
  enabled: boolean;
  /** "tailscale" (default) or "lan". */
  via: "tailscale" | "lan";
  /** Address to listen on (resolved when turned on; re-resolved at start if it changed). */
  host?: string;
  /** Extra names devices may use in the address bar (e.g. the Tailscale MagicDNS name). */
  names?: string[];
}

export function readRemote(): RemoteConfig {
  try {
    return { enabled: false, via: "tailscale", ...JSON.parse(readFileSync(CONFIG, "utf8")) };
  } catch {
    return { enabled: false, via: "tailscale" };
  }
}

export function writeRemote(cfg: RemoteConfig) {
  ensureHome();
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** The token other devices use. Created when remote access is first turned on. */
export function deviceToken(create = false): string | undefined {
  if (!existsSync(DEVICE_TOKEN)) {
    if (!create) return undefined;
    ensureHome();
    writeFileSync(DEVICE_TOKEN, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  chmodSync(DEVICE_TOKEN, 0o600);
  return readFileSync(DEVICE_TOKEN, "utf8").trim();
}

export function resetDeviceToken(): string {
  rmSync(DEVICE_TOKEN, { force: true });
  return deviceToken(true)!;
}

/** This Mac's Tailscale address and name, if Tailscale is running. */
export function tailscale(): { ip: string; name?: string } | undefined {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const status = JSON.parse(execFileSync(bin, ["status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }));
      const ip = (status.Self?.TailscaleIPs ?? []).find((x: string) => x.includes("."));
      if (ip) return { ip, name: String(status.Self?.DNSName ?? "").replace(/\.$/, "") || undefined };
    } catch {
      // not installed / not running
    }
  }
  // Tailscale's addresses are in 100.64.0.0/10; find one on an interface even without the CLI.
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4") continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 100 && y >= 64 && y <= 127) return { ip: a.address };
    }
  }
  return undefined;
}

/** The address on the local network (Wi-Fi/Ethernet). */
export function lanAddress(): string | undefined {
  const order = ["en0", "en1", "eth0", "wlan0"];
  const ifaces = networkInterfaces();
  const names = [...order.filter((n) => ifaces[n]), ...Object.keys(ifaces).filter((n) => !order.includes(n))];
  for (const n of names) {
    for (const a of ifaces[n] ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return undefined;
}

/** Resolve where to listen right now; undefined if that network isn't available. */
export function resolveHost(cfg: RemoteConfig): { host: string; names: string[] } | undefined {
  if (cfg.via === "lan") {
    const ip = lanAddress();
    return ip ? { host: ip, names: [`${hostname().split(".")[0]}.local`] } : undefined;
  }
  const ts = tailscale();
  return ts ? { host: ts.ip, names: ts.name ? [ts.name] : [] } : undefined;
}

export function pairingUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/#token=${token}`;
}

export function sshCommand(port: number): string {
  return `ssh -N -L ${port}:127.0.0.1:${port} ${userInfo().username}@${hostname()}`;
}

export async function qrSvg(text: string): Promise<string> {
  const QR = (await import("qrcode")).default;
  return QR.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

export async function qrTerminal(text: string): Promise<string> {
  const QR = (await import("qrcode")).default;
  return QR.toString(text, { type: "terminal", small: true });
}
