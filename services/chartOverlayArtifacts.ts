/**
 * Evidence vrstev, které graf přidává nad svíčky (FVG, levely, popisky
 * struktury, průběh pozice, značky vstupu/výstupu, pomocné čáry).
 *
 * ChartView (CandleKit) umí vydat NOVÝ objekt `api` nad STEJNÝM grafem —
 * stačí, aby se změnil objekt s nastavením kreslení (LIVE graf se sdílenou
 * vrstvou kreseb při přepnutí timeframu: jiný rozsah načtených dnů = nový
 * kreslicí ovladač). Staré vrstvy proto nejde jen zapomenout s tím, že
 * „starý graf už neexistuje“: zůstaly by připojené k té samé sérii a kreslily
 * se podruhé, potřetí… (sytější FVG, zdvojené pozice přichycené ke starým
 * datům). Před každou přestavbou se tedy všechno, co je v evidenci, odpojí
 * od grafu, ke kterému to bylo připojeno. U grafu, který mezitím opravdu
 * zanikl, odpojení selže a chyba se ignoruje.
 */
export interface OverlaySeries<Primitive> {
  detachPrimitive: (primitive: Primitive) => void;
}

export interface OverlayChart<Line> {
  removeSeries: (line: Line) => void;
}

export interface OverlayApi<Line, Primitive> {
  controller: {
    getChart: () => OverlayChart<Line>;
    getSeries: () => unknown;
  };
}

export interface OverlayMarkers {
  detach: () => void;
}

export interface OverlayArtifacts<Api, Line, Primitive> {
  api: Api | null;
  lines: Line[];
  primitives: Primitive[];
  markers: OverlayMarkers[];
}

export const emptyOverlayArtifacts = <Api, Line, Primitive>(
  api: Api | null = null,
): OverlayArtifacts<Api, Line, Primitive> => ({ api, lines: [], primitives: [], markers: [] });

/** Odpojí od grafu všechno, co evidence drží. Zaniklý graf nevadí. */
export const releaseOverlayArtifacts = <Api extends OverlayApi<Line, Primitive>, Line, Primitive>(
  artifacts: OverlayArtifacts<Api, Line, Primitive>,
): void => {
  const { api } = artifacts;
  if (!api) return;
  let chart: OverlayChart<Line> | null = null;
  let series: OverlaySeries<Primitive> | null = null;
  try {
    chart = api.controller.getChart();
    series = api.controller.getSeries() as OverlaySeries<Primitive>;
  } catch { /* graf už zanikl */ }
  artifacts.markers.forEach(markers => {
    try { markers.detach(); } catch { /* graf už zanikl */ }
  });
  artifacts.primitives.forEach(primitive => {
    try { series?.detachPrimitive(primitive); } catch { /* graf už zanikl */ }
  });
  artifacts.lines.forEach(line => {
    try { chart?.removeSeries(line); } catch { /* graf už zanikl */ }
  });
};

/**
 * Začátek přestavby vrstev: staré odpojí (i když přišlo nové `api` — může
 * stát nad stejným grafem) a vrátí prázdnou evidenci pro `api`.
 */
export const restartOverlayArtifacts = <Api extends OverlayApi<Line, Primitive>, Line, Primitive>(
  current: OverlayArtifacts<Api, Line, Primitive>,
  api: Api,
): OverlayArtifacts<Api, Line, Primitive> => {
  releaseOverlayArtifacts(current);
  return emptyOverlayArtifacts<Api, Line, Primitive>(api);
};
