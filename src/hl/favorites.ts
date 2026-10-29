import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Starred chart tokens.
 *
 * One person uses this desk, so a flat list of coin names is enough and keeps
 * the file readable. It sits next to following.json in the data dir and is
 * rewritten on every edit; a failed write must never take the desk down.
 */
export class Favorites {
  private path: string;
  private coins: string[];

  constructor(dataDir: string) {
    this.path = join(dataDir, "favorites.json");
    this.coins = this.load();
  }

  private load(): string[] {
    try {
      if (!existsSync(this.path)) return [];
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const list = Array.isArray(raw) ? raw : (raw as { coins?: unknown } | null)?.coins;
      if (!Array.isArray(list)) return [];
      return list
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.trim().toUpperCase())
        .filter((c, i, all) => all.indexOf(c) === i)
        .slice(0, 40);
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ coins: this.coins }, null, 1));
    } catch {
      /* ignore */
    }
  }

  list(): string[] {
    return [...this.coins];
  }

  add(coin: string): string[] {
    const c = coin.trim().toUpperCase();
    if (c && !this.coins.includes(c)) {
      this.coins = [...this.coins, c].slice(0, 40);
      this.save();
    }
    return this.list();
  }

  remove(coin: string): string[] {
    const c = coin.trim().toUpperCase();
    const next = this.coins.filter((x) => x !== c);
    if (next.length !== this.coins.length) {
      this.coins = next;
      this.save();
    }
    return this.list();
  }
}
