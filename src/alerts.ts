/**
 * Discord embeds for trade alerts, shared by both venues.
 *
 * Discord will not render SVG thumbnails, so coin art has to be a raster URL.
 * GMX's token list carries CoinGecko art for most tickers and is the cheapest
 * one stop map; anything missing gets a letter tile, which always renders.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const letterIcon = (sym: string) =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(sym)}&background=0a1220&color=4aa8ff&size=64&bold=true&format=png`;

let iconCache: { at: number; map: Map<string, string> } | null = null;

/** symbol -> coin image URL, cached for thirty minutes. */
export async function iconMap(): Promise<Map<string, string>> {
  if (iconCache && Date.now() - iconCache.at < 30 * 60_000) return iconCache.map;
  const map = new Map<string, string>();
  try {
    const res = await fetch("https://arbitrum.gmxapi.io/v1/tokens/info", {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ symbol?: string; imageUrl?: string }>;
      for (const t of rows) {
        const sym = (t.symbol ?? "").toUpperCase();
        if (sym && t.imageUrl) map.set(sym, t.imageUrl);
      }
    }
  } catch {
    /* fall back to letter tiles */
  }
  iconCache = { at: Date.now(), map };
  return map;
}

/** Coin art for a ticker; strips the 1000x "k" prefix Hyperliquid uses. */
export function iconFor(sym: string, map: Map<string, string>): string {
  const upper = sym.toUpperCase();
  const base = upper.replace(/^K(?=[A-Z0-9])/, "");
  return map.get(upper) ?? map.get(base) ?? letterIcon(upper);
}

export interface AlertInput {
  venue: "hyperliquid" | "gmx";
  coin: string;
  side: "buy" | "sell";
  size: number;
  notional: number;
  price: number;
  wallet: string;
  fills: number;
  chartUrl: string;
  explorerUrl: string;
  iconUrl: string;
  windowMinutes: number;
}

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const qty = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4);
const px = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(5);

/** The webhook body for one alert. */
export function alertPayload(a: AlertInput) {
  const verb = a.side === "buy" ? "Bought" : "Sold";
  const amount = a.size > 0 ? `${qty(a.size)} ` : "";
  const fields = [
    ...(a.price > 0 ? [{ name: "Price", value: `$${px(a.price)}`, inline: true }] : []),
    { name: "Notional", value: money(a.notional), inline: true },
    { name: "Fills", value: `${a.fills} in ${a.windowMinutes}m`, inline: true },
    {
      name: "Open",
      value: `[${a.venue === "gmx" ? "GMX" : "Hyperliquid"} chart](${a.chartUrl}) · [Wallet](${a.explorerUrl})`,
      inline: false,
    },
  ];
  return {
    username: "FERNO DESK",
    embeds: [
      {
        title: `${verb} ${amount}${a.coin}`,
        url: a.chartUrl,
        color: a.side === "buy" ? 0x4aa8ff : 0xff8c42,
        author: { name: `${a.wallet.slice(0, 6)}.${a.wallet.slice(-4)}`, url: a.explorerUrl },
        thumbnail: { url: a.iconUrl },
        fields,
        footer: { text: `ferno desk · ${a.venue} · one alert per wallet per ${a.windowMinutes}m` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** A test embed, so the panel can prove the hook works. */
export function testPayload(venue: "hyperliquid" | "gmx") {
  return {
    username: "FERNO DESK",
    embeds: [
      {
        title: "Alerts are wired up",
        description: `This is what a ${venue === "gmx" ? "GMX" : "Hyperliquid"} fill alert will look like. Real ones fire when a favourite trades.`,
        color: 0x4aa8ff,
        footer: { text: "ferno desk · test" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function postWebhook(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Webhook URLs live in config; show only the tail. */
export const maskWebhook = (url: string) => url.replace(/\/[^/]+$/, "/…" + url.slice(-4));
