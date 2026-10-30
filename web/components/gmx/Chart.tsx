import { useEffect, useMemo, useRef, useState } from "react";

const INTERVALS = ["5m", "15m", "1h", "4h", "1d"] as const;

type Point = { time: number; price: number };
type LinePoint = { time: number; value: number };

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ChartPayload {
  symbol: string;
  interval: string;
  candles: Candle[];
  band: { upper: LinePoint[]; lower: LinePoint[] } | null;
  basis: LinePoint[];
  macd: { line: LinePoint[]; signal: LinePoint[]; hist: LinePoint[] } | null;
  markers: { long: number[]; short: number[] } | null;
  trend?: number;
  macdTrend?: number;
}

interface LCSeries {
  setData: (d: unknown[]) => void;
  setMarkers?: (m: unknown[]) => void;
  coordinateToPrice?: (y: number) => number | null;
}
interface LCChart {
  addCandlestickSeries: (o: Record<string, unknown>) => LCSeries;
  addLineSeries: (o: Record<string, unknown>) => LCSeries;
  addHistogramSeries: (o: Record<string, unknown>) => LCSeries;
  removeSeries: (s: unknown) => void;
  subscribeClick: (h: (p: { time?: unknown; point?: { x: number; y: number } }) => void) => void;
  timeScale: () => {
    fitContent: () => void;
    setVisibleLogicalRange: (r: { from: number; to: number }) => void;
    getVisibleLogicalRange: () => { from: number; to: number } | null;
    subscribeVisibleLogicalRangeChange: (h: (r: { from: number; to: number } | null) => void) => void;
  };
  remove: () => void;
}
type LCModule = { createChart: (el: HTMLElement, o: Record<string, unknown>) => LCChart };

// Crypto prices need more decimals the smaller they get; two is fine for BTC
// and useless for DOGE at 0.76 or PEPE at 0.000008.
const dp = (n: number) => (n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : n >= 0.0001 ? 6 : 8);
const priceFormat = (n: number) => {
  const precision = dp(n);
  return { type: "price", precision, minMove: 10 ** -precision };
};
const fmt = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toFixed(dp(n)));

const BASE_OPTS = {
  layout: { background: { color: "transparent" }, textColor: "rgba(255,255,255,0.5)", fontSize: 11 },
  grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
  rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
  timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
  crosshair: { mode: 0 },
};

function SymbolPicker({
  symbols,
  symbol,
  onPick,
  favs,
  onToggleFav,
}: {
  symbols: string[];
  symbol: string;
  onPick: (s: string) => void;
  favs: string[];
  onToggleFav: (s: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const list = useMemo(() => {
    const term = q.trim().toUpperCase();
    if (!term) return symbols;
    const starts = symbols.filter((s) => s.startsWith(term));
    const rest = symbols.filter((s) => !s.startsWith(term) && s.includes(term));
    return [...starts, ...rest];
  }, [symbols, q]);

  // Starred markets that exist here, above the full list. The token store is
  // shared with Hyperliquid, so a coin starred on either side shows on both.
  const pinned = useMemo(() => favs.filter((s) => symbols.includes(s)), [favs, symbols]);

  const row = (s: string) => {
    const on = favs.includes(s);
    return (
      <div key={s} className="hl-picker__row">
        <button
          type="button"
          role="option"
          aria-selected={s === symbol}
          className={s === symbol ? "is-on" : ""}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
            setOpen(false);
          }}
        >
          <span>{s}</span>
        </button>
        <button
          type="button"
          className={`hl-picker__star ${on ? "is-on" : ""}`}
          aria-label={on ? `unstar ${s}` : `star ${s}`}
          title={on ? `remove ${s} from favourites` : `save ${s} to favourites`}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFav(s);
          }}
        >
          {on ? "★" : "☆"}
        </button>
      </div>
    );
  };

  return (
    <div className="hl-picker">
      <input
        className="hl-input hl-input--coin"
        value={open ? q : symbol}
        placeholder="search market"
        aria-label="search market"
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open ? (
        <div className="hl-picker__list" role="listbox">
          {pinned.length && !q.trim() ? (
            <>
              <span className="hl-picker__group">favourites</span>
              {pinned.map(row)}
              <span className="hl-picker__group">all markets</span>
            </>
          ) : null}
          {list
            .filter((s) => q.trim() || !favs.includes(s))
            .slice(0, 80)
            .map(row)}
          {list.length === 0 ? <span className="hl-picker__empty">no market matches that</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function GmxChart() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("BTC");
  const [interval, setInterval] = useState<string>("1h");
  const [data, setData] = useState<ChartPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInd, setShowInd] = useState(true);
  const [measure, setMeasure] = useState<{ a: Point; b: Point | null } | null>(null);
  const [armed, setArmed] = useState(false);
  const [favs, setFavs] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/favorites")
      .then((r) => r.json())
      .then((body: { ok: boolean; coins?: string[] }) => {
        if (alive && body.ok && Array.isArray(body.coins)) setFavs(body.coins);
      })
      .catch(() => {
        /* a missing endpoint just means no stars */
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleFav = async (target: string) => {
    const before = favs;
    const on = before.includes(target);
    setFavs(on ? before.filter((c) => c !== target) : [...before, target]);
    try {
      const res = await fetch(on ? `/api/favorites/${encodeURIComponent(target)}` : "/api/favorites", {
        method: on ? "DELETE" : "POST",
        headers: on ? undefined : { "content-type": "application/json" },
        body: on ? undefined : JSON.stringify({ coin: target }),
      });
      const body = (await res.json()) as { ok: boolean; coins?: string[] };
      if (!body.ok || !Array.isArray(body.coins)) throw new Error("not saved");
      setFavs(body.coins);
    } catch {
      setFavs(before);
    }
  };

  const starred = favs.includes(symbol);
  const quick = favs.filter((s) => symbols.includes(s));

  const armedRef = useRef(false);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  const priceHost = useRef<HTMLDivElement>(null);
  const macdHost = useRef<HTMLDivElement>(null);
  const chartRef = useRef<LCChart | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/gmx/markets")
      .then((r) => r.json())
      .then((body: { ok: boolean; symbols?: string[] }) => {
        if (alive && body.ok && Array.isArray(body.symbols)) setSymbols(body.symbols);
      })
      .catch(() => {
        /* picker stays with the current symbol */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    fetch(`/api/gmx/chart?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&bars=400`)
      .then((r) => r.json())
      .then((body: { ok: boolean; error?: string } & ChartPayload) => {
        if (!alive) return;
        if (!body.ok || !body.candles) throw new Error(body.error ?? "chart unavailable");
        setData(body);
        setMeasure(null);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol, interval]);

  useEffect(() => {
    const LC = (window as unknown as { LightweightCharts?: LCModule }).LightweightCharts;
    const priceEl = priceHost.current;
    const macdEl = macdHost.current;
    if (!LC || !priceEl || !data || data.candles.length === 0) return;

    const price = LC.createChart(priceEl, { ...BASE_OPTS, autoSize: true });
    const pf = priceFormat(data.candles[data.candles.length - 1]!.close);
    const candles = price.addCandlestickSeries({
      upColor: "#4aa8ff",
      downColor: "#ff8c42",
      wickUpColor: "#4aa8ff",
      wickDownColor: "#ff8c42",
      borderVisible: false,
      priceFormat: pf,
    });
    candles.setData(data.candles);

    if (showInd && data.band) {
      const upper = price.addLineSeries({ color: "rgba(74,168,255,0.55)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: pf });
      upper.setData(data.band.upper);
      const lower = price.addLineSeries({ color: "rgba(255,140,66,0.55)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: pf });
      lower.setData(data.band.lower);
      const basis = price.addLineSeries({
        color: "rgba(255,255,255,0.28)",
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: pf,
      });
      basis.setData(data.basis);
    }

    if (showInd && data.markers && candles.setMarkers) {
      const times = new Set(data.candles.map((c) => c.time));
      candles.setMarkers([
        ...data.markers.long.filter((t) => times.has(t)).map((t) => ({
          time: t,
          position: "belowBar",
          color: "#4aa8ff",
          shape: "arrowUp",
          text: "",
        })),
        ...data.markers.short.filter((t) => times.has(t)).map((t) => ({
          time: t,
          position: "aboveBar",
          color: "#ff8c42",
          shape: "arrowDown",
          text: "",
        })),
      ]);
    }

    price.subscribeClick((p) => {
      if (!armedRef.current) return;
      if (!p.point || typeof p.time !== "number") return;
      const value = candles.coordinateToPrice?.(p.point.y);
      if (value == null) return;
      const point: Point = { time: p.time, price: value };
      setMeasure((prev) => {
        if (!prev || prev.b) return { a: point, b: null };
        if (prev.a.time === point.time) return prev;
        setArmed(false);
        return { a: prev.a, b: point };
      });
    });

    chartRef.current = price;

    let macd: LCChart | null = null;
    if (showInd && data.macd && macdEl) {
      macd = LC.createChart(macdEl, { ...BASE_OPTS, autoSize: true });
      const firstMacd = data.macd.line[0]?.time ?? null;
      const lead = firstMacd == null ? [] : data.candles.filter((c) => c.time < firstMacd).map((c) => ({ time: c.time }));

      const hist = macd.addHistogramSeries({ priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false });
      hist.setData([
        ...lead,
        ...data.macd.hist.map((p) => ({ ...p, color: p.value >= 0 ? "rgba(74,168,255,0.45)" : "rgba(255,140,66,0.45)" })),
      ]);
      const line = macd.addLineSeries({ color: "rgba(255,255,255,0.75)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      line.setData([...lead, ...data.macd.line]);
      const sig = macd.addLineSeries({ color: "rgba(255,209,102,0.9)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      sig.setData([...lead, ...data.macd.signal]);

      let guard = false;
      price.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (!r || guard || !macd) return;
        guard = true;
        macd.timeScale().setVisibleLogicalRange(r);
        guard = false;
      });
      macd.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (!r || guard) return;
        guard = true;
        price.timeScale().setVisibleLogicalRange(r);
        guard = false;
      });
    }

    price.timeScale().fitContent();
    if (macd) {
      const range = price.timeScale().getVisibleLogicalRange();
      if (range) macd.timeScale().setVisibleLogicalRange(range);
    }

    return () => {
      price.remove();
      macd?.remove();
      chartRef.current = null;
    };
  }, [data, showInd]);

  // measurement line
  useEffect(() => {
    const chart = chartRef.current;
    const LC = (window as unknown as { LightweightCharts?: LCModule }).LightweightCharts;
    if (!chart || !LC || !measure?.b) return;
    const { a, b } = measure;
    const line = chart.addLineSeries({
      color: b.price >= a.price ? "#4aa8ff" : "#ff8c42",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: priceFormat(b.price),
    });
    line.setData([a, b].sort((x, y) => x.time - y.time).map((p) => ({ time: p.time, value: p.price })));
    return () => {
      try {
        chart.removeSeries(line);
      } catch {
        /* chart gone */
      }
    };
  }, [measure]);

  const a = measure?.a ?? null;
  const b = measure?.b ?? null;
  const move = a && b ? (b.price / a.price - 1) * 100 : null;
  const trendText =
    data?.trend == null ? "" : data.trend > 0 ? "zero-lag long" : data.trend < 0 ? "zero-lag short" : "zero-lag flat";

  return (
    <section className="hl-panel hl-panel--fill">
      <div className="hl-panel__head hl-chartbar">
        <h2 className="lab">CHART</h2>
        <SymbolPicker
          symbols={symbols}
          symbol={symbol}
          onPick={setSymbol}
          favs={favs}
          onToggleFav={(s) => void toggleFav(s)}
        />
        <button
          type="button"
          className={`chip hl-fav ${starred ? "is-on" : ""}`}
          aria-pressed={starred}
          title={starred ? `remove ${symbol} from favourites` : `save ${symbol} to favourites`}
          onClick={() => void toggleFav(symbol)}
        >
          {starred ? "★ saved" : "☆ save"}
        </button>
        <div className="hl-seg">
          {INTERVALS.map((i) => (
            <button key={i} type="button" className={`chip ${interval === i ? "is-on" : ""}`} onClick={() => setInterval(i)}>
              {i}
            </button>
          ))}
        </div>
        <button type="button" className={`chip ${showInd ? "is-on" : ""}`} onClick={() => setShowInd(!showInd)}>
          indicators
        </button>
        <span className="hl-grow" />
        <button
          type="button"
          className={`chip ${armed ? "is-on" : ""}`}
          onClick={() => {
            setArmed(!armed);
            if (!armed) setMeasure(null);
          }}
        >
          {armed ? "click 2 points" : "measure"}
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => {
            setMeasure(null);
            setArmed(false);
          }}
        >
          clear
        </button>
      </div>

      {error ? <div className="hl-error">{error}</div> : null}

      {quick.length ? (
        <div className="hl-favbar">
          <span className="hl-lab">favourites</span>
          {quick.map((s) => (
            <button key={s} type="button" className={`chip ${s === symbol ? "is-on" : ""}`} onClick={() => setSymbol(s)}>
              ★ {s}
            </button>
          ))}
        </div>
      ) : null}

      <div className="hl-measure">
        {a && b && move != null ? (
          <>
            <span className="num">
              {fmt(a.price)} to {fmt(b.price)}
            </span>
            <b className={`num ${move >= 0 ? "is-up" : "is-down"}`}>
              {move >= 0 ? "+" : ""}
              {move.toFixed(2)}%
            </b>
            <span className="hl-note">
              {move >= 0 ? "up" : "down"} move · {Math.abs((b.time - a.time) / 3600).toFixed(1)}h apart · click again to start a new measure
            </span>
          </>
        ) : a ? (
          <>
            <span className="num">from {fmt(a.price)}</span>
            <span className="hl-note">click the end of the move</span>
          </>
        ) : armed ? (
          <span className="hl-note">measure mode: click the start of the move</span>
        ) : (
          <span className="hl-note">
            press measure, then click two points on the chart to see the move in percent
            {trendText ? ` · ${trendText}` : ""}
          </span>
        )}
      </div>

      <div className={`hl-candlewrap ${armed ? "is-measuring" : ""}`}>
        <div ref={priceHost} className="hl-candles hl-candles--tall" />
        {busy ? <span className="hl-loading">loading {symbol} {interval}…</span> : null}
      </div>

      {showInd ? (
        <div className="hl-macd">
          <div className="hl-chart__head">
            <span className="lab">MACD 12 · 26 · 9</span>
            <span className="hl-grow" />
            <span className="hl-note">
              band 70 · {data?.macdTrend != null && data.macdTrend > 0 ? "macd long" : data?.macdTrend != null && data.macdTrend < 0 ? "macd short" : "macd flat"}
            </span>
          </div>
          <div ref={macdHost} className="hl-macd__host" />
        </div>
      ) : null}
    </section>
  );
}
