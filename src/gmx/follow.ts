import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Starred GMX wallets.
 *
 * A flat list of addresses in the data dir, next to following.json and
 * favorites.json. No alerts: GMX polling for notifications is not built.
 */
export class GmxFollowing {
  private path: string;
  private addrs: string[];

  constructor(dataDir: string) {
    this.path = join(dataDir, "gmx-following.json");
    this.addrs = this.load();
  }

  private load(): string[] {
    try {
      if (!existsSync(this.path)) return [];
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : (raw as { wallets?: unknown } | null)?.wallets;
      if (!Array.isArray(list)) return [];
      const out: string[] = [];
      for (const a of list) {
        if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
        // Keep the venue's own casing: the indexer compares addresses exactly.
        if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
      }
      return out.slice(0, 50);
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ wallets: this.addrs }, null, 1));
    } catch {
      /* ignore */
    }
  }

  list(): string[] {
    return [...this.addrs];
  }

  has(addr: string): boolean {
    return this.addrs.some((x) => x.toLowerCase() === addr.toLowerCase());
  }

  add(addr: string): string[] {
    if (/^0x[0-9a-fA-F]{40}$/.test(addr) && !this.has(addr)) {
      this.addrs = [...this.addrs, addr].slice(0, 50);
      this.save();
    }
    return this.list();
  }

  remove(addr: string): string[] {
    const next = this.addrs.filter((x) => x.toLowerCase() !== addr.toLowerCase());
    if (next.length !== this.addrs.length) {
      this.addrs = next;
      this.save();
    }
    return this.list();
  }
}
