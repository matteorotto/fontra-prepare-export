// Prepara per l'export — plugin per Fontra
//
// Controlla tutto il font prima dell'export e sistema i tracciati, come faceva
// Glyphs esportando:
// - unisce i tracciati che si sovrappongono (le forme di costruzione diventano
//   una forma sola), in tutti i master;
// - toglie i punti doppi (due punti uno sopra l'altro);
// - arrotonda le coordinate dei punti a numeri interi;
// - segnala quello che va sistemato a mano: master che non si corrispondono,
//   sovrapposizioni che non si possono unire senza rompere l'interpolazione,
//   contorni aperti, componenti mancanti, Unicode doppi, nomi non validi…
//
// Il font esce come font variabile: i 9 master devono restare compatibili
// (stessi contorni, stessi punti, nello stesso ordine). L'unione si fa solo
// dove il risultato resta compatibile in tutti i master; negli altri glifi le
// sovrapposizioni restano (il font variabile funziona lo stesso) e il plugin
// dice, master per master, cosa non combacia nel disegno.
//
// Niente cambia finché non premi Applica. Le modifiche si fanno nella
// panoramica del font (File → Prepara per l'export…) e si annullano con ⌘Z.
// Da usare su una COPIA del font: File → Esporta come → .fontra.

const EDITOR_KEY = "__prepareExportPlugin";
const OVERVIEW_KEY = "__prepareExportOverview";
const OVERVIEW_POLL_MS = 1500;
const META = "prepareExportPlugin";
const DIALOG_TAG = "fontra-prepare-export-dialog";
const GLYPHS_PER_CHUNK = 40;
const UNION_CONCURRENCY = 6;
const SKIP_EXPORT_KEY = "public.skipExportGlyphs";
const TINY_SEGMENT = 8; // unità: segmenti più corti di così sono sospetti
const MENU_TITLE = "Prepara per l'export…";
const MENU_TITLE_EDITOR = "Controlla il font per l'export…";

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHTML(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Contorni: lettura, scrittura, confronti
// Un contorno è { closed, pts: [{ x, y, t, s, a }] }: t = 0 punto sul
// contorno, 1 maniglia quadratica, 2 maniglia cubica; s = punto liscio;
// a = attributi del punto (se ci sono).
// ---------------------------------------------------------------------------

function readContours(path) {
  const coordinates = path?.coordinates || [];
  const pointTypes = path?.pointTypes || [];
  const contourInfo = path?.contourInfo || [];
  const attributes = path?.pointAttributes || null;
  const contours = [];
  let start = 0;
  for (const info of contourInfo) {
    const pts = [];
    for (let i = start; i <= info.endPoint; i++) {
      const type = pointTypes[i] || 0;
      pts.push({
        x: coordinates[2 * i],
        y: coordinates[2 * i + 1],
        t: type & 0x03,
        s: type & 0x08 ? 1 : 0,
        a: attributes?.[i] ?? null,
      });
    }
    contours.push({ closed: !!info.isClosed, pts });
    start = info.endPoint + 1;
  }
  return contours;
}

function packContours(contours, { keepAttributes = true } = {}) {
  const coordinates = [];
  const pointTypes = [];
  const contourInfo = [];
  const pointAttributes = [];
  let anyAttributes = false;
  for (const contour of contours) {
    for (const p of contour.pts) {
      coordinates.push(p.x, p.y);
      pointTypes.push(p.t | (p.s && p.t === 0 ? 0x08 : 0));
      const a = keepAttributes ? p.a ?? null : null;
      if (a) anyAttributes = true;
      pointAttributes.push(a);
    }
    contourInfo.push({ endPoint: pointTypes.length - 1, isClosed: contour.closed });
  }
  return { coordinates, pointTypes, contourInfo, pointAttributes: anyAttributes ? pointAttributes : null };
}

function mapPoints(contours, fn) {
  return contours.map((c) => ({ closed: c.closed, pts: c.pts.map(fn) }));
}

function roundContours(contours) {
  return mapPoints(contours, (p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y) }));
}

function countNonInteger(contours) {
  let n = 0;
  for (const c of contours) for (const p of c.pts) if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) n++;
  return n;
}

// Gli indici dei punti di troppo: un tratto che parte e arriva nello stesso
// punto (due punti uno sopra l'altro, con o senza maniglie in mezzo).
// Si tiene il primo punto, si tolgono gli altri del tratto.
function duplicateIndices(contour) {
  const pts = contour.pts;
  const n = pts.length;
  const ons = [];
  for (let i = 0; i < n; i++) if (pts[i].t === 0) ons.push(i);
  const remove = new Set();
  if (ons.length < 2) return remove;
  const segments = contour.closed ? ons.length : ons.length - 1;
  for (let k = 0; k < segments; k++) {
    const a = ons[k];
    const b = ons[(k + 1) % ons.length];
    const idx = [];
    for (let i = (a + 1) % n; ; i = (i + 1) % n) {
      idx.push(i);
      if (i === b) break;
    }
    const p0 = pts[a];
    if (idx.every((i) => pts[i].x === p0.x && pts[i].y === p0.y)) {
      // il punto di partenza non si toglie mai due volte
      if (remove.has(a)) continue;
      for (const i of idx) remove.add(i);
    }
  }
  // non lasciare un contorno con meno di due punti
  const left = ons.filter((i) => !remove.has(i)).length;
  if (left < 2) return new Set();
  return remove;
}

function removeIndices(contours, perContour) {
  return contours.map((c, ci) => {
    const drop = perContour[ci];
    if (!drop || !drop.size) return c;
    return { closed: c.closed, pts: c.pts.filter((_, i) => !drop.has(i)) };
  });
}

function dedupeContours(contours) {
  return removeIndices(contours, contours.map(duplicateIndices)).filter((c) => c.pts.length > 1);
}

function signature(contours) {
  return contours.map((c) => (c.closed ? "c" : "o") + c.pts.map((p) => p.t).join("")).join("|");
}

function shapeKey(contours) {
  return contours
    .map((c) => c.pts.map((p) => `${p.x},${p.y}`).sort().join(" "))
    .sort()
    .join("|");
}

function contourArea(contour) {
  const p = contour.pts;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function reverseContour(contour) {
  if (!contour.closed || contour.pts.length < 2) return { closed: contour.closed, pts: [...contour.pts].reverse() };
  const [first, ...rest] = contour.pts;
  return { closed: true, pts: [first, ...rest.reverse()] };
}

// Contorni esterni in senso antiorario (come vuole il formato PostScript/CFF)
function normalizeDirection(contours) {
  const total = contours.reduce((sum, c) => sum + contourArea(c), 0);
  return total < 0 ? contours.map(reverseContour) : contours;
}

function bounds(contours) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const c of contours) {
    for (const p of c.pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.x > xMax) xMax = p.x;
      if (p.y > yMax) yMax = p.y;
    }
  }
  return xMin === Infinity ? null : { xMin, yMin, xMax, yMax };
}

function boxesTouch(a, b) {
  return !!a && !!b && a.xMin <= b.xMax && b.xMin <= a.xMax && a.yMin <= b.yMax && b.yMin <= a.yMax;
}

// Un contorno come elenco di tratti: ogni tratto parte da un punto sul
// contorno ed ha 0 maniglie (linea) o 2 (curva)
function toSegments(contour) {
  const pts = contour.pts;
  const first = pts.findIndex((p) => p.t === 0);
  if (first < 0) return null;
  const rotated = [...pts.slice(first), ...pts.slice(0, first)];
  const segments = [];
  for (const p of rotated) {
    if (p.t === 0) segments.push({ on: p, offs: [] });
    else segments[segments.length - 1].offs.push(p);
  }
  return segments;
}

function fromSegments(segments, closed) {
  const pts = [];
  for (const s of segments) pts.push(s.on, ...s.offs);
  return { closed, pts };
}

// Riordina i contorni di ogni master e ne sposta il punto di partenza perché
// corrispondano punto per punto a quelli del primo master. Se in un master un
// tratto è una linea e negli altri una curva (succede quando le maniglie di una
// curva sono allineate: l'unione la trasforma in linea), la linea diventa una
// curva con le maniglie a un terzo e due terzi: la forma non cambia.
// null se i master non si possono far corrispondere.
function matchAllContours(results) {
  const reference = results[0];
  const refSegs = reference.map(toSegments);
  if (refSegs.some((s) => !s)) return null;
  const refBox = bounds(reference) || { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const norm = (p, b) => [(p.x - b.xMin) / Math.max(b.xMax - b.xMin, 1), (p.y - b.yMin) / Math.max(b.yMax - b.yMin, 1)];
  const aligned = [refSegs];
  for (let li = 1; li < results.length; li++) {
    const contours = results[li];
    if (contours.length !== reference.length) return null;
    const segs = contours.map(toSegments);
    if (segs.some((s) => !s)) return null;
    const box = bounds(contours) || refBox;
    const used = new Set();
    const out = [];
    for (let ri = 0; ri < reference.length; ri++) {
      const rs = refSegs[ri];
      const n = rs.length;
      const rNorm = rs.map((s) => norm(s.on, refBox));
      const rSign = contourArea(reference[ri]) >= 0;
      let best = null;
      segs.forEach((cs, j) => {
        if (used.has(j) || cs.length !== n || contours[j].closed !== reference[ri].closed) return;
        if (contourArea(contours[j]) >= 0 !== rSign) return;
        const cNorm = cs.map((s) => norm(s.on, box));
        const rotations = contours[j].closed ? n : 1;
        for (let k = 0; k < rotations; k++) {
          let d = 0;
          for (let i = 0; i < n; i++) {
            const a = cNorm[(i + k) % n];
            d += Math.hypot(a[0] - rNorm[i][0], a[1] - rNorm[i][1]);
          }
          d /= n;
          if (!best || d < best.d) best = { d, j, k };
        }
      });
      if (!best) return null;
      used.add(best.j);
      const cs = segs[best.j];
      out.push(cs.map((_, i) => cs[(i + best.k) % n]));
    }
    aligned.push(out);
  }
  // tratto per tratto: tutti linee, tutti curve, o linee da trasformare in curve
  for (let ci = 0; ci < reference.length; ci++) {
    const n = refSegs[ci].length;
    for (let si = 0; si < n; si++) {
      const kinds = aligned.map((a) => a[ci][si].offs.map((p) => p.t).join(""));
      if (kinds.every((k) => k === kinds[0])) continue;
      const curve = kinds.find((k) => k.length);
      if (curve !== "22" || !kinds.every((k) => k === "" || k === "22")) return null;
      aligned.forEach((a) => {
        const seg = a[ci][si];
        if (seg.offs.length) return;
        const next = a[ci][(si + 1) % n].on;
        const p0 = seg.on;
        seg.offs = [
          { x: Math.round(p0.x + (next.x - p0.x) / 3), y: Math.round(p0.y + (next.y - p0.y) / 3), t: 2, s: 0, a: null },
          { x: Math.round(p0.x + (2 * (next.x - p0.x)) / 3), y: Math.round(p0.y + (2 * (next.y - p0.y)) / 3), t: 2, s: 0, a: null },
        ];
      });
    }
  }
  return aligned.map((a, li) => a.map((segments, ci) => fromSegments(segments, results[li][ci].closed)));
}

// L'unione ha davvero unito qualcosa? Se ha solo tolto maniglie allineate o
// punti su una linea dritta (stessi contorni, nessun punto nuovo), no.
function realOverlap(original, union) {
  if (original.length !== union.length) return true;
  const onCurve = new Set();
  for (const c of original) for (const p of c.pts) if (p.t === 0) onCurve.add(`${p.x},${p.y}`);
  for (const c of union) for (const p of c.pts) if (p.t === 0 && !onCurve.has(`${p.x},${p.y}`)) return true;
  return false;
}

// Tratti cortissimi e contorni minuscoli: di solito sono bordi di due forme
// che quasi combaciano (e in un altro master combaciano, o si incrociano)
function suspiciousSpots(contours) {
  const spots = [];
  for (const c of contours) {
    const box = bounds([c]);
    const w = box.xMax - box.xMin;
    const h = box.yMax - box.yMin;
    if (c.closed && (w < TINY_SEGMENT || h < TINY_SEGMENT || Math.abs(contourArea(c)) < 4 * TINY_SEGMENT * TINY_SEGMENT)) {
      spots.push({ kind: "contour", x: Math.round((box.xMin + box.xMax) / 2), y: Math.round((box.yMin + box.yMax) / 2), w: Math.round(w), h: Math.round(h) });
      continue;
    }
    const ons = c.pts.map((p, i) => (p.t === 0 ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < (c.closed ? ons.length : ons.length - 1); k++) {
      const a = c.pts[ons[k]];
      const b = c.pts[ons[(k + 1) % ons.length]];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 0 && len < TINY_SEGMENT) {
        spots.push({ kind: "segment", x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), len: Math.round(len * 10) / 10 });
      }
    }
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Unione dei tracciati: la fa il server di Fontra (lo stesso comando di
// "Remove overlaps" del pannello Trasformazione), con skia-pathops.
// ---------------------------------------------------------------------------

class UnionService {
  constructor() {
    this.cache = new Map();
    this.queue = [];
    this.running = 0;
  }

  union(contours) {
    const packed = packContours(contours, { keepAttributes: false });
    const key = JSON.stringify([packed.coordinates, packed.pointTypes, packed.contourInfo]);
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        this.schedule(() => this.call(packed)).then((path) => dedupeContours(normalizeDirection(roundContours(readContours(path)))))
      );
    }
    return this.cache.get(key);
  }

  schedule(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.running < UNION_CONCURRENCY && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async call(path) {
    const response = await fetch("/api/unionPath", { method: "POST", body: JSON.stringify({ path }) });
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return result.returnValue;
  }
}

// ---------------------------------------------------------------------------
// Analisi del font
// ---------------------------------------------------------------------------

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9._\-]*$/;

async function fontSourceNames(fc) {
  let sources = {};
  try {
    sources = (await fc.getSources?.()) || fc.sources || {};
  } catch (error) {
    sources = fc.sources || {};
  }
  return sources;
}

class FontAnalyzer {
  constructor(fc) {
    this.fc = fc;
    this.unions = new UnionService();
  }

  async run(onProgress, isCancelled) {
    const fc = this.fc;
    this.sources = await fontSourceNames(fc);
    const glyphMap = fc.glyphMap || {};
    const names = Object.keys(glyphMap);
    const skip = new Set(fc.customData?.[SKIP_EXPORT_KEY] || []);
    const report = {
      total: names.length,
      skipExport: skip,
      glyphs: new Map(), // nome → risultato del glifo
      duplicateUnicodes: [],
      invalidNames: [],
      emptyWithUnicode: [],
      errors: [],
    };

    // Unicode usati da più glifi
    const byCodePoint = new Map();
    for (const [name, codePoints] of Object.entries(glyphMap)) {
      for (const cp of codePoints || []) {
        if (!byCodePoint.has(cp)) byCodePoint.set(cp, []);
        byCodePoint.get(cp).push(name);
      }
    }
    for (const [cp, glyphs] of byCodePoint) if (glyphs.length > 1) report.duplicateUnicodes.push({ cp, glyphs });

    // Nomi
    for (const name of names) {
      if (name === ".notdef" || name === ".null") continue;
      if (!VALID_NAME.test(name) || name.length > 63) report.invalidNames.push(name);
    }

    let done = 0;
    const batch = 8;
    for (let i = 0; i < names.length; i += batch) {
      if (isCancelled?.()) return null;
      const slice = names.slice(i, i + batch);
      const results = await Promise.all(
        slice.map((name) =>
          this.analyzeGlyph(name).catch((error) => {
            console.error(`[Prepara export] ${name}:`, error);
            report.errors.push({ name, message: error?.message || String(error) });
            return null;
          })
        )
      );
      slice.forEach((name, k) => {
        if (results[k]) report.glyphs.set(name, results[k]);
      });
      done += slice.length;
      onProgress?.(done, names.length);
    }

    report.unreachable = await this.unreachableGlyphs(report);
    report.notExported = new Set([...skip, ...report.unreachable]);

    for (const [name, g] of report.glyphs) {
      const codePoints = glyphMap[name] || [];
      if (!codePoints.length || g.hasOutlines) continue;
      const char = String.fromCodePoint(codePoints[0]);
      // spazi e caratteri invisibili sono vuoti per natura
      if (/[\p{Z}\p{Cc}\p{Cf}]/u.test(char)) continue;
      report.emptyWithUnicode.push(name);
    }
    return report;
  }

  // L'export di Fontra Pak lascia fuori i glifi "irraggiungibili": senza un
  // carattere, non usati dalle funzioni OpenType e non usati come componente
  // da un glifo che resta. Le funzioni OpenType si guardano solo per nome.
  async unreachableGlyphs(report) {
    const fc = this.fc;
    const glyphMap = fc.glyphMap || {};
    let featureText = "";
    try {
      const features = await fc.getFeatures?.();
      featureText = features?.text || "";
    } catch (error) {
      featureText = "";
    }
    const inFeatures = new Set(featureText.match(/[A-Za-z0-9_.\-]+/g) || []);
    const reachable = new Set();
    const stack = [];
    for (const [name, codePoints] of Object.entries(glyphMap)) {
      if (codePoints?.length || inFeatures.has(name) || name === ".notdef") stack.push(name);
    }
    while (stack.length) {
      const name = stack.pop();
      if (reachable.has(name)) continue;
      reachable.add(name);
      const g = report.glyphs.get(name);
      for (const layer of g?.layers || []) {
        for (const c of layer.glyph.components || []) if (!reachable.has(c.name)) stack.push(c.name);
      }
    }
    return Object.keys(glyphMap).filter((name) => !reachable.has(name));
  }

  sourceName(source, layerName) {
    return this.sources[source.locationBase]?.name || source.name || this.sources[layerName]?.name || layerName;
  }

  async analyzeGlyph(name) {
    const fc = this.fc;
    const varGlyph = await fc.getGlyph(name);
    if (!varGlyph) return null;
    const layers = [];
    const seen = new Set();
    for (const [sourceIndex, source] of varGlyph.sources.entries()) {
      const layer = varGlyph.glyph.layers[source.layerName];
      if (source.inactive || !layer || seen.has(source.layerName)) continue;
      seen.add(source.layerName);
      const controller = await fc.getLayerGlyphController(name, source.layerName, sourceIndex);
      let location = null;
      try {
        location = varGlyph.getDenseSourceLocationForSource(source);
      } catch (error) {
        location = null;
      }
      layers.push({
        sourceIndex,
        layerName: source.layerName,
        sourceName: this.sourceName(source, source.layerName),
        location,
        glyph: layer.glyph,
        controller,
        own: readContours(layer.glyph.path),
      });
    }
    const g = {
      name,
      layers,
      hasOutlines: layers.some((l) => l.own.length || l.glyph.components?.length),
      issues: {},
      plan: null, // { kind: "union" | "decompose", paths: [contorni per livello] }
      overlap: "none", // none | fixable | incompatible | skipped
    };
    if (!layers.length) return g;

    // --- controlli sul disegno ------------------------------------------------
    const open = layers.filter((l) => l.own.some((c) => !c.closed));
    if (open.length) g.issues.open = open.map((l) => l.sourceName);

    g.nonInteger = layers.reduce((n, l) => n + countNonInteger(l.own), 0);

    const negative = layers.filter((l) => (l.glyph.xAdvance ?? 0) < 0);
    if (negative.length) g.issues.negativeWidth = negative.map((l) => `${l.sourceName} (${l.glyph.xAdvance})`);

    const missing = new Set();
    for (const l of layers) for (const c of l.glyph.components || []) if (!(c.name in fc.glyphMap)) missing.add(c.name);
    if (missing.size) g.issues.missingComponents = [...missing];

    // Compatibilità tra i master (senza compatibilità il font variabile non si esporta)
    const sigs = layers.map((l) => signature(l.own));
    const compos = layers.map((l) => (l.glyph.components || []).map((c) => c.name).join(","));
    const anchors = layers.map((l) => (l.glyph.anchors || []).map((a) => a.name).sort().join(","));
    const compatible = sigs.every((s) => s === sigs[0]) && compos.every((c) => c === compos[0]);
    if (!compatible) g.issues.incompatible = describeIncompatibility(layers, sigs, compos);
    if (!anchors.every((a) => a === anchors[0])) g.issues.anchors = describeGroups(layers, anchors, (key) => (key ? key.split(",").join(" ") : "nessuna"));

    // Punti doppi: si tolgono solo se sono doppi nello stesso posto in tutti i master
    const rounded = layers.map((l) => roundContours(l.own));
    if (compatible) {
      const perLayer = rounded.map((cs) => cs.map(duplicateIndices));
      const common = rounded[0].map((_, ci) => {
        const sets = perLayer.map((p) => p[ci]);
        return new Set([...sets[0]].filter((i) => sets.every((s) => s.has(i))));
      });
      const someOnly = [];
      perLayer.forEach((p, li) => {
        p.forEach((set, ci) => {
          for (const i of set) {
            if (!common[ci].has(i)) {
              const pt = rounded[li][ci].pts[i];
              someOnly.push(`${layers[li].sourceName} (${pt.x}, ${pt.y})`);
            }
          }
        });
      });
      g.duplicates = common.reduce((n, s) => n + s.size, 0);
      g.duplicateRemoval = common;
      if (someOnly.length) g.issues.duplicatesSomeMasters = [...new Set(someOnly)];
    } else {
      g.duplicates = 0;
    }

    // --- sovrapposizioni ------------------------------------------------------
    if (!compatible) {
      g.overlap = "skipped";
      return g;
    }
    await this.analyzeOverlaps(g, rounded);
    return g;
  }

  async analyzeOverlaps(g, rounded) {
    const layers = g.layers;
    const hasComponents = layers.some((l) => l.glyph.components?.length);
    const cleanOwn = rounded.map((cs) => dedupeContours(cs));

    // Unione del solo disegno del glifo (senza componenti)
    const unionOwn = async () =>
      Promise.all(cleanOwn.map((cs) => (cs.length ? this.unions.union(cs) : Promise.resolve([]))));

    let kind = "union";
    let results;
    let originals = cleanOwn;
    let pointSource = rounded; // i punti originali, con lo stesso indice in ogni master
    if (!hasComponents) {
      if (!cleanOwn.some((cs) => cs.length)) return;
      results = await unionOwn();
    } else {
      // I pezzi: il disegno del glifo e ogni componente, già posizionato
      const pieces = layers.map((l, li) => [
        cleanOwn[li],
        ...(l.controller.components || []).map((c) => dedupeContours(roundContours(readContours(c.path)))),
      ]);
      const touch = pieces.some((ps) => {
        const boxes = ps.map((p) => bounds(p));
        for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) if (boxesTouch(boxes[a], boxes[b])) return true;
        return false;
      });
      if (touch) {
        const flatRounded = layers.map((l) => roundContours(readContours(l.controller.flattenedPath)));
        const flat = flatRounded.map((cs) => dedupeContours(cs));
        const unionFlat = await Promise.all(flat.map((cs) => (cs.length ? this.unions.union(cs) : Promise.resolve([]))));
        const separate = await Promise.all(
          pieces.map(async (ps) => (await Promise.all(ps.map((p) => (p.length ? this.unions.union(p) : Promise.resolve([]))))).flat())
        );
        const crossOverlap = unionFlat.some((u, li) => shapeKey(u) !== shapeKey(separate[li]));
        if (crossOverlap) {
          kind = "decompose";
          results = unionFlat;
          originals = flat;
          pointSource = flatRounded;
        }
      }
      if (!results) {
        if (!cleanOwn.some((cs) => cs.length)) return;
        results = await unionOwn();
      }
    }

    const changed = results.some((r, li) => realOverlap(originals[li], r));
    if (!changed) return;

    // I master devono restare compatibili: stessi contorni e punti, nello stesso ordine
    const matched = matchAllContours(results);
    const contourCountBefore = originals[0].length;
    const contourCountAfter = results[0].length;
    if (matched) {
      g.overlap = "fixable";
      g.plan = { kind, paths: matched, contoursBefore: contourCountBefore, contoursAfter: contourCountAfter };
    } else {
      g.overlap = "incompatible";
      g.unionKind = kind;
      g.diagnosis = diagnoseUnion(layers, results, pointSource);
    }
  }
}

function describeGroups(layers, keys, format) {
  const groups = new Map();
  keys.forEach((key, i) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(layers[i]);
  });
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, ls]) => ({ masters: ls.map((l) => l.sourceName), text: format(key), sourceIndex: ls[0].sourceIndex, layer: ls[0] }));
}

function shapeSummary(contours) {
  if (!contours.length) return "nessun contorno";
  return `${plural(contours.length, "contorno", "contorni")} (${contours.map((c) => c.pts.length).join(", ")} punti)`;
}

function describeIncompatibility(layers, sigs, compos) {
  const keys = layers.map((l, i) => `${sigs[i]}#${compos[i]}`);
  return describeGroups(layers, keys, (key) => {
    const layer = layers[keys.indexOf(key)];
    const comps = (layer.glyph.components || []).map((c) => c.name);
    const own = shapeSummary(layer.own);
    const open = layer.own.some((c) => !c.closed) ? ", con contorni aperti" : "";
    return comps.length ? `${own}${open} + componenti ${comps.join(", ")}` : own + open;
  });
}

// Perché l'unione dà forme diverse: i master raggruppati per risultato e, nei
// gruppi in minoranza, dove sta la differenza rispetto al gruppo più grande.
// I punti originali hanno lo stesso numero in ogni master: ogni punto del
// risultato è un punto originale (che resta sul contorno) oppure un incrocio
// tra due forme. Confrontando i master si vede quale punto resta sul contorno
// in un master e finisce dentro la forma in un altro, e dove ci sono incroci
// in più o in meno.
function diagnoseUnion(layers, results, pointSource) {
  const keys = results.map((r) => r.map((c) => c.pts.length).join(","));
  const groups = describeGroups(layers, keys, (key) => shapeSummary(results[keys.indexOf(key)]));
  const classified = results.map((r, li) => classifyUnionPoints(r, pointSource[li]));
  const ref = classified[layers.indexOf(groups[0].layer)];
  groups.forEach((group, gi) => {
    if (gi === 0) return;
    const li = layers.indexOf(group.layer);
    const here = classified[li];
    const spots = [];
    for (const id of here.kept) {
      if (!ref.kept.has(id)) spots.push({ kind: "keptHere", ...pointAt(pointSource[li], id) });
    }
    for (const id of ref.kept) {
      if (!here.kept.has(id)) spots.push({ kind: "droppedHere", ...pointAt(pointSource[li], id) });
    }
    // incroci tra due tratti originali: in più qui, o che qui mancano
    for (const [key, list] of here.crossings) {
      const n = ref.crossings.get(key)?.length || 0;
      for (const p of list.slice(n)) spots.push({ kind: "extraCrossing", x: p.x, y: p.y });
    }
    for (const [key, list] of ref.crossings) {
      const n = here.crossings.get(key)?.length || 0;
      if (list.length <= n) continue;
      const near = closestApproach(here.segments, key);
      // se i due tratti sono lontani l'abbinamento non è sicuro: meglio tacere
      if (near && near.gap <= 40) spots.push({ kind: "missingCrossing", ...near });
    }
    for (const s of suspiciousSpots(results[li])) {
      if (s.kind === "segment" && !spots.some((m) => Math.abs(m.x - s.x) < 20 && Math.abs(m.y - s.y) < 20)) spots.push(s);
    }
    // stessi posti una volta sola
    const seen = new Set();
    group.spots = spots
      .filter((s) => {
        const k = `${s.kind}:${Math.round((s.x ?? 0) / 4)}:${Math.round((s.y ?? 0) / 4)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 6);
  });
  return groups;
}

function pointAt(contours, id) {
  const [ci, pi] = id.split(":").map(Number);
  const p = contours[ci]?.pts[pi];
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

// I tratti originali, ognuno come spezzata di punti (per misurare distanze)
function sampledSegments(contours) {
  const result = [];
  contours.forEach((contour, ci) => {
    const segs = toSegments(contour);
    if (!segs) return;
    const n = segs.length;
    const last = contour.closed ? n : n - 1;
    for (let si = 0; si < last; si++) {
      const p0 = segs[si].on;
      const p3 = segs[(si + 1) % n].on;
      const offs = segs[si].offs;
      const samples = [];
      const steps = offs.length ? 48 : 1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        if (offs.length === 2) {
          const [p1, p2] = offs;
          const u = 1 - t;
          samples.push({
            x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
          });
        } else if (offs.length === 1) {
          const [p1] = offs;
          const u = 1 - t;
          samples.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p3.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p3.y });
        } else {
          samples.push({ x: p0.x + t * (p3.x - p0.x), y: p0.y + t * (p3.y - p0.y) });
        }
      }
      result.push({ id: `${ci}:${si}`, samples });
    }
  });
  return result;
}

function distanceToPolyline(p, samples) {
  let best = Infinity;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// Dove due tratti si avvicinano di più (dove in questo master non si incrociano)
function closestApproach(segments, key) {
  const [idA, idB] = key.split("+");
  const a = segments.find((s) => s.id === idA);
  const b = segments.find((s) => s.id === idB);
  if (!a || !b) return null;
  let best = null;
  for (const p of a.samples) {
    for (const q of b.samples) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (!best || d < best.d) best = { d, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }
  }
  return best ? { x: Math.round(best.x), y: Math.round(best.y), gap: Math.round(best.d * 10) / 10 } : null;
}

// Ogni punto del risultato è un punto originale (con il suo numero, uguale in
// tutti i master) oppure un incrocio tra due tratti originali
function classifyUnionPoints(result, original) {
  const byCoord = new Map();
  original.forEach((c, ci) =>
    c.pts.forEach((p, pi) => {
      if (p.t !== 0) return;
      const key = `${p.x},${p.y}`;
      if (!byCoord.has(key)) byCoord.set(key, `${ci}:${pi}`);
    })
  );
  const segments = sampledSegments(original);
  const kept = new Set();
  const crossings = new Map();
  for (const c of result) {
    for (const p of c.pts) {
      if (p.t !== 0) continue;
      const id = byCoord.get(`${p.x},${p.y}`);
      if (id) {
        kept.add(id);
        continue;
      }
      const near = segments
        .map((s) => ({ id: s.id, d: distanceToPolyline(p, s.samples) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 2);
      const key = near.map((s) => s.id).sort().join("+") || "?";
      if (!crossings.has(key)) crossings.set(key, []);
      crossings.get(key).push({ x: p.x, y: p.y });
    }
  }
  return { kept, crossings, segments };
}

function spotText(spot) {
  switch (spot.kind) {
    case "contour":
      return `contorno minuscolo (${spot.w} × ${spot.h}) vicino a ${spot.x}, ${spot.y}`;
    case "segment":
      return `tratto di ${spot.len} unità vicino a ${spot.x}, ${spot.y}`;
    case "keptHere":
      return `il punto ${spot.x}, ${spot.y} qui resta sul contorno, negli altri master finisce dentro la forma`;
    case "droppedHere":
      return `il punto ${spot.x}, ${spot.y} qui finisce dentro la forma, negli altri master resta sul contorno`;
    case "extraCrossing":
      return `qui le forme si incrociano in ${spot.x}, ${spot.y}, negli altri master no`;
    case "missingCrossing":
      return `vicino a ${spot.x}, ${spot.y} qui le forme non si incrociano (${spot.gap ? `distano ${spot.gap} unità` : "si toccano appena"}), negli altri master sì`;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Le modifiche
// ---------------------------------------------------------------------------

class ChangeBuilder {
  constructor() {
    this.forward = [];
    this.backward = [];
  }

  get isEmpty() {
    return !this.forward.length;
  }

  set(path, key, newValue, oldValue) {
    this.forward.push({ p: path, f: "=", a: [key, clone(newValue)] });
    this.backward.unshift(
      oldValue === undefined ? { p: path, f: "d", a: [key] } : { p: path, f: "=", a: [key, clone(oldValue)] }
    );
  }

  build(label) {
    return {
      change: { c: this.forward, [META]: { label } },
      rollbackChange: { c: this.backward, [META]: { label } },
    };
  }
}

function pathToPlain(path) {
  return {
    coordinates: [...(path?.coordinates || [])],
    pointTypes: [...(path?.pointTypes || [])],
    contourInfo: (path?.contourInfo || []).map((c) => ({ endPoint: c.endPoint, isClosed: !!c.isClosed })),
    pointAttributes: path?.pointAttributes ? clone([...path.pointAttributes]) : null,
  };
}

function samePath(a, b) {
  return JSON.stringify(pathToPlain(a)) === JSON.stringify(pathToPlain(b));
}

// Cosa cambia, glifo per glifo, con le opzioni scelte
function planChanges(report, options) {
  const builder = new ChangeBuilder();
  const counts = { glyphs: 0, union: 0, decompose: 0, duplicates: 0, rounded: 0 };
  for (const g of report.glyphs.values()) {
    if (!g.layers.length) continue;
    let touched = false;
    const useUnion = options.union && g.overlap === "fixable" && g.plan;
    g.layers.forEach((layer, li) => {
      let contours;
      let decompose = false;
      if (useUnion) {
        contours = g.plan.paths[li];
        decompose = g.plan.kind === "decompose";
      } else {
        contours = layer.own;
        // i punti doppi sono cercati sulle coordinate arrotondate: gli indici
        // valgono anche per quelle originali
        if (options.duplicates && g.duplicateRemoval && g.duplicates) contours = removeIndices(contours, g.duplicateRemoval);
        if (options.round) contours = roundContours(contours);
      }
      const newPath = packContours(contours, { keepAttributes: !useUnion });
      const base = ["glyphs", g.name, "layers", layer.layerName, "glyph"];
      if (!samePath(newPath, layer.glyph.path)) {
        builder.set(base, "path", newPath, pathToPlain(layer.glyph.path));
        touched = true;
      }
      if (decompose && layer.glyph.components?.length) {
        builder.set(base, "components", [], clone(layer.glyph.components));
        touched = true;
      }
    });
    if (touched) {
      counts.glyphs++;
      if (useUnion) counts[g.plan.kind === "decompose" ? "decompose" : "union"]++;
      else {
        if (options.duplicates && g.duplicates) counts.duplicates++;
        if (options.round && g.nonInteger) counts.rounded++;
      }
    }
  }
  return { builder, counts };
}

function glyphNameOfChange(change) {
  const path = change.p || [];
  if (path[0] !== "glyphs") return null;
  return path.length > 1 ? path[1] : change.a?.[0] ?? null;
}

function countGlyphs(change) {
  return new Set((change.c || []).map(glyphNameOfChange).filter((n) => n !== null)).size;
}

// Il server di Fontra tiene in memoria al massimo 128 glifi per volta:
// le modifiche grandi partono a blocchi.
async function postChunked(fc, change, label) {
  let chunk = [];
  let names = new Set();
  const send = async () => {
    if (!chunk.length) return;
    await fc.postChange({ c: chunk, [META]: change[META] }, { c: [] }, label);
    chunk = [];
    names = new Set();
  };
  for (const sub of change.c || []) {
    const name = glyphNameOfChange(sub);
    if (name !== null && !names.has(name) && names.size >= GLYPHS_PER_CHUNK) await send();
    if (name !== null) names.add(name);
    chunk.push(sub);
  }
  await send();
}

// ---------------------------------------------------------------------------
// Finestra
// ---------------------------------------------------------------------------

const DIALOG_CSS = `
  :host { all: initial; }
  .overlay {
    position: fixed; inset: 0; z-index: 1000; background: #0006;
    display: flex; align-items: center; justify-content: center;
    font-family: fontra-ui-regular, -apple-system, system-ui, sans-serif; font-size: 12px;
  }
  .box {
    background: var(--ui-element-background-color, #fff); color: var(--ui-element-foreground-color, #222);
    border-radius: 10px; box-shadow: 0 10px 40px #0006; width: min(980px, 95vw); max-height: 90vh;
    display: flex; flex-direction: column;
  }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 4px; }
  .head b { font-size: 14px; }
  .head .x { margin-left: auto; border: none; font-size: 18px; opacity: 0.6; padding: 0 6px; }
  .content { overflow: auto; padding: 0 16px 10px; }
  .foot { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid #8883; flex-wrap: wrap; }
  .foot .msg { flex: 1; opacity: 0.85; min-width: 200px; }
  h3 { font-size: 12.5px; margin: 16px 0 4px; }
  h4 { font-size: 12px; margin: 12px 0 2px; display: flex; gap: 6px; align-items: center; }
  p { margin: 3px 0 6px; line-height: 1.45; opacity: 0.85; }
  .progress { height: 6px; border-radius: 3px; background: #8883; overflow: hidden; margin: 8px 0; }
  .progress div { height: 100%; background: #3b82f6; width: 0; transition: width 0.15s; }
  .summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .chip { padding: 3px 9px; border-radius: 10px; background: #8882; }
  .chip.ok { background: #16a34a22; color: #15803d; }
  .chip.warn { background: #f59f0022; color: #b45309; }
  .chip.bad { background: #e0313122; color: #c92a2a; }
  label.opt { display: flex; gap: 6px; align-items: baseline; margin: 6px 0 2px; }
  label.opt b { font-size: 12.5px; }
  .names { margin: 2px 0 6px 22px; line-height: 1.7; }
  .glyph {
    display: inline-block; padding: 0 5px; margin: 0 2px 2px 0; border-radius: 4px; background: #8881;
    cursor: pointer; white-space: nowrap;
  }
  .glyph:hover { background: #3b82f633; }
  .glyph .ch { opacity: 0.6; margin-left: 3px; }
  details { margin: 2px 0 2px 22px; }
  details summary { cursor: pointer; opacity: 0.75; }
  table { border-collapse: collapse; margin: 4px 0 8px; }
  td { padding: 3px 8px 3px 0; vertical-align: top; border-bottom: 1px solid #8882; line-height: 1.45; }
  td.g { white-space: nowrap; }
  .master { color: #2563eb; cursor: pointer; }
  .master:hover { text-decoration: underline; }
  .spot { color: #c92a2a; }
  .muted { opacity: 0.6; }
  .none { opacity: 0.6; }
  .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: #8882; font-weight: normal; }
  .tag.ok { background: #16a34a22; color: #15803d; }
  .tag.bad { background: #e0313122; color: #c92a2a; }
  .tag.warn { background: #f59f0022; color: #b45309; }
  button {
    font: inherit; color: inherit; border-radius: 5px; border: 1px solid #8884;
    background: transparent; padding: 3px 9px; cursor: pointer;
  }
  button.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  button:disabled { opacity: 0.4; cursor: default; }
  .copy-check { display: flex; gap: 6px; align-items: center; }
  .note { border-radius: 6px; background: #f59f0018; padding: 6px 9px; margin: 8px 0; line-height: 1.45; }
`;

class PrepareExportDialogElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${DIALOG_CSS}</style>
      <div class="overlay">
        <div class="box">
          <div class="head"><b id="title">Prepara per l'export</b><button class="x" id="close" title="Chiudi (Esc)">×</button></div>
          <div class="content" id="content"></div>
          <div class="foot">
            <span class="msg" id="msg"></span>
            <button id="copy" title="Copia il resoconto come testo">Copia resoconto</button>
            <button id="recheck" title="Rifai il controllo">Ricontrolla</button>
            <button id="cancel">Chiudi</button>
            <button class="primary" id="apply">Applica</button>
          </div>
        </div>
      </div>`;
    this.$ = (sel) => this.shadowRoot.querySelector(sel);
  }
}
if (!customElements.get(DIALOG_TAG)) customElements.define(DIALOG_TAG, PrepareExportDialogElement);

// host: { fc, canApply, apply(builder, label), openGlyph(name, layer) }
class PrepareExportDialog {
  constructor(host) {
    this.host = host;
    this.fc = host.fc;
    this.options = { union: true, duplicates: true, round: true };
    this.isCopy = false;
  }

  async open() {
    this.element = document.createElement(DIALOG_TAG);
    document.body.appendChild(this.element);
    const $ = this.element.$;
    const close = () => this.close();
    $("#close").addEventListener("click", close);
    $("#cancel").addEventListener("click", close);
    $(".overlay").addEventListener("pointerdown", (event) => {
      if (event.target === $(".overlay")) close();
    });
    this.element.addEventListener("keydown", (event) => event.stopPropagation());
    this.onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", this.onKey, true);
    $("#apply").addEventListener("click", () => this.apply());
    $("#recheck").addEventListener("click", () => this.analyze());
    $("#copy").addEventListener("click", () => this.copyReport());
    $("#title").textContent = this.host.canApply ? "Prepara per l'export" : "Controlla il font per l'export";
    $("#apply").hidden = !this.host.canApply;
    await this.analyze();
  }

  close() {
    this.cancelled = true;
    window.removeEventListener("keydown", this.onKey, true);
    this.element?.remove();
    this.element = null;
    this.restoreButton?.remove();
    this.restoreButton = null;
  }

  async analyze() {
    if (!this.element) return;
    const $ = this.element.$;
    this.report = null;
    this.cancelled = false;
    $("#apply").disabled = true;
    $("#recheck").disabled = true;
    $("#copy").disabled = true;
    $("#msg").textContent = "";
    $("#content").innerHTML =
      `<p>Controllo tutti i glifi e provo a unire i tracciati in ogni master. Non cambia niente.</p>` +
      `<div class="progress"><div id="bar"></div></div><p class="muted" id="count"></p>`;
    const started = Date.now();
    try {
      const analyzer = new FontAnalyzer(this.fc);
      const report = await analyzer.run(
        (done, total) => {
          if (!this.element) return;
          $("#bar").style.width = `${Math.round((100 * done) / total)}%`;
          $("#count").textContent = `${done} / ${total} glifi`;
        },
        () => this.cancelled
      );
      if (!report || !this.element) return;
      report.seconds = Math.round((Date.now() - started) / 100) / 10;
      this.report = report;
      this.render();
    } catch (error) {
      console.error("[Prepara export]", error);
      if (this.element) $("#content").innerHTML = `<p>Il controllo si è fermato: ${escapeHTML(error?.message || error)}</p>`;
    } finally {
      if (this.element) {
        $("#recheck").disabled = false;
        $("#copy").disabled = !this.report;
      }
    }
  }

  glyphChip(name, { tag = true } = {}) {
    const cp = this.fc.glyphMap[name]?.[0];
    const ch = cp !== undefined && name.length > 1 ? `<span class="ch">${escapeHTML(String.fromCodePoint(cp))}</span>` : "";
    const skip = tag && this.report?.notExported?.has(name) ? ` <span class="muted">(non esportato)</span>` : "";
    return `<span class="glyph" data-glyph="${escapeHTML(name)}" title="Apri ${escapeHTML(name)}">${escapeHTML(name)}${ch}${skip}</span>`;
  }

  chips(names, max = 400, options = {}) {
    const shown = names.slice(0, max).map((n) => this.glyphChip(n, options)).join("");
    return shown + (names.length > max ? ` <span class="muted">… e altri ${names.length - max}</span>` : "");
  }

  masterLink(name, group) {
    const masters = group.masters.map((m) => escapeHTML(m)).join(", ");
    return `<span class="master" data-glyph="${escapeHTML(name)}" data-source="${group.sourceIndex}" title="Apri ${escapeHTML(name)} in ${escapeHTML(group.masters[0])}">${masters}</span>`;
  }

  render() {
    const report = this.report;
    const $ = this.element.$;
    const glyphs = [...report.glyphs.values()];
    const fixable = glyphs.filter((g) => g.overlap === "fixable");
    const decompose = fixable.filter((g) => g.plan.kind === "decompose");
    const incompatibleUnion = glyphs.filter((g) => g.overlap === "incompatible");
    const incompatible = glyphs.filter((g) => g.issues.incompatible);
    const withDuplicates = glyphs.filter((g) => g.duplicates);
    const duplicateCount = withDuplicates.reduce((n, g) => n + g.duplicates, 0);
    const withNonInteger = glyphs.filter((g) => g.nonInteger);
    const by = (key) => glyphs.filter((g) => g.issues[key]);
    const open = by("open");
    const missing = by("missingComponents");
    const negative = by("negativeWidth");
    const anchors = by("anchors");
    const dupSome = by("duplicatesSomeMasters");
    const sortNames = (list) => list.map((g) => g.name);

    const manualCount =
      incompatibleUnion.length + incompatible.length + open.length + missing.length + negative.length +
      report.duplicateUnicodes.length + report.invalidNames.length + dupSome.length + report.errors.length;
    const fileName = decodeURIComponent(new URL(window.location.href).searchParams.get("project") || "").split("/").pop();

    let html = "";
    html +=
      `<div class="summary">` +
      `<span class="chip">${plural(report.total, "glifo controllato", "glifi controllati")} in ${report.seconds} s</span>` +
      `<span class="chip ${fixable.length ? "warn" : "ok"}">${plural(fixable.length, "glifo", "glifi")} da unire</span>` +
      `<span class="chip ${incompatibleUnion.length ? "bad" : "ok"}">${plural(incompatibleUnion.length, "glifo", "glifi")} non unibili</span>` +
      `<span class="chip ${manualCount ? "bad" : "ok"}">${manualCount ? plural(manualCount, "cosa", "cose") + " da vedere a mano" : "niente da sistemare a mano"}</span>` +
      `</div>`;

    // --- 1. Correzioni automatiche ---------------------------------------------
    html += `<h3>Da sistemare in automatico</h3>`;
    html += this.host.canApply
      ? `<p>Scegli cosa fare e premi <b>Applica</b>: un solo passo, che si annulla con ⌘Z.</p>`
      : `<p>Qui nell'editor il plugin controlla soltanto. Per applicare le correzioni apri la panoramica del font e usa <b>File → ${escapeHTML(MENU_TITLE)}</b>, su una copia del font.</p>`;

    html +=
      `<label class="opt"><input type="checkbox" id="opt-union" ${this.options.union ? "checked" : ""} ${this.host.canApply ? "" : "disabled"}>` +
      `<span><b>Unisci i tracciati sovrapposti</b> — ${plural(fixable.length, "glifo", "glifi")}, in tutti i master. ` +
      `Le forme di costruzione diventano una forma sola; il disegno non cambia.</span></label>`;
    if (fixable.length) {
      html += `<div class="names">${this.chips(sortNames(fixable))}</div>`;
      if (decompose.length) {
        html +=
          `<details><summary>${plural(decompose.length, "glifo ha", "glifi hanno")} componenti che si sovrappongono al disegno: vengono scomposti e poi uniti</summary>` +
          `<div class="names">${this.chips(sortNames(decompose))}</div></details>`;
      }
    }
    html +=
      `<label class="opt"><input type="checkbox" id="opt-duplicates" ${this.options.duplicates ? "checked" : ""} ${this.host.canApply ? "" : "disabled"}>` +
      `<span><b>Togli i punti doppi</b> — ${plural(duplicateCount, "punto", "punti")} in ${plural(withDuplicates.length, "glifo", "glifi")} ` +
      `(punti uno sopra l'altro, nello stesso posto in tutti i master).</span></label>`;
    if (withDuplicates.length) html += `<div class="names">${this.chips(sortNames(withDuplicates))}</div>`;
    html +=
      `<label class="opt"><input type="checkbox" id="opt-round" ${this.options.round ? "checked" : ""} ${this.host.canApply ? "" : "disabled"}>` +
      `<span><b>Arrotonda le coordinate</b> — ${plural(withNonInteger.length, "glifo ha", "glifi hanno")} punti con i decimali.</span></label>`;
    if (withNonInteger.length) html += `<div class="names">${this.chips(sortNames(withNonInteger))}</div>`;
    html += `<p class="muted">I glifi uniti hanno anche i punti doppi tolti e le coordinate arrotondate.</p>`;

    // --- 2. Da vedere a mano ----------------------------------------------------
    html += `<h3>Da sistemare a mano</h3><p>Queste cose il plugin non le cambia. Clicca un glifo per aprirlo; clicca i nomi dei master per aprirlo proprio in quel master.</p>`;

    const section = (title, count, body, level = "bad") =>
      `<h4>${escapeHTML(title)} <span class="tag ${count ? level : "ok"}">${count ? count : "nessuno ✓"}</span></h4>` + (count ? body : "");

    // Sovrapposizioni non unibili
    let body =
      `<p>Unendo i tracciati, questi glifi vengono diversi da un master all'altro (un punto o un contorno in più), e il font variabile non potrebbe più interpolarli. ` +
      `Restano con le sovrapposizioni: il font funziona lo stesso, ma convertendo il testo in tracciati le forme di costruzione si vedono. ` +
      `Di solito il motivo è che due forme quasi combaciano: in un master i bordi coincidono o si toccano appena, negli altri si incrociano. ` +
      `Allinea i bordi (o falli sovrapporre di più) nei master indicati, poi ricontrolla.</p><table>`;
    for (const g of incompatibleUnion) {
      body += `<tr><td class="g">${this.glyphChip(g.name)}${g.unionKind === "decompose" ? `<br><span class="muted">con componenti</span>` : ""}</td><td>`;
      body += g.diagnosis
        .map((group, i) => {
          const spots = group.spots?.length ? `<br><span class="spot">${group.spots.map(spotText).map(escapeHTML).join(" · ")}</span>` : "";
          return `${i === 0 ? "" : "<br>"}${this.masterLink(g.name, group)}: ${escapeHTML(group.text)}${spots}`;
        })
        .join("");
      body += `</td></tr>`;
    }
    body += `</table>`;
    html += section("Sovrapposizioni che non si possono unire", incompatibleUnion.length, body);

    // Master incompatibili
    body =
      `<p>I master di questi glifi non hanno gli stessi contorni, punti o componenti: il font variabile non si può esportare finché non corrispondono (l'export si ferma con un errore).</p><table>`;
    for (const g of incompatible) {
      body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${g.issues.incompatible
        .map((group) => `${this.masterLink(g.name, group)}: ${escapeHTML(group.text)}`)
        .join("<br>")}</td></tr>`;
    }
    body += `</table>`;
    html += section("Master che non si corrispondono", incompatible.length, body);

    // Punti doppi solo in alcuni master
    body = `<p>Qui due punti sono uno sopra l'altro solo in alcuni master: toglierli romperebbe la corrispondenza tra i master. Sposta il punto, o toglilo in tutti i master.</p><table>`;
    for (const g of dupSome) body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${escapeHTML(g.issues.duplicatesSomeMasters.slice(0, 6).join(" · "))}</td></tr>`;
    body += `</table>`;
    html += section("Punti doppi solo in alcuni master", dupSome.length, body, "warn");

    // Contorni aperti
    body = `<p>Un contorno aperto non riempie niente: nel font esportato sparisce o si chiude da solo con una linea dritta.</p><table>`;
    for (const g of open) body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${escapeHTML(g.issues.open.join(", "))}</td></tr>`;
    body += `</table>`;
    html += section("Contorni aperti", open.length, body);

    // Componenti mancanti
    body = `<p>Questi glifi usano come componente un glifo che non esiste (forse rinominato o cancellato): quel pezzo non viene esportato.</p><table>`;
    for (const g of missing) body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${escapeHTML(g.issues.missingComponents.join(", "))}</td></tr>`;
    body += `</table>`;
    html += section("Componenti di glifi che non esistono", missing.length, body);

    // Unicode doppi
    body = `<p>Lo stesso carattere è assegnato a più glifi: scrivendo, il programma ne usa uno solo.</p><table>`;
    for (const d of report.duplicateUnicodes) {
      body += `<tr><td class="g">U+${d.cp.toString(16).toUpperCase().padStart(4, "0")} ${escapeHTML(String.fromCodePoint(d.cp))}</td><td>${this.chips(d.glyphs)}</td></tr>`;
    }
    body += `</table>`;
    html += section("Unicode usati da più glifi", report.duplicateUnicodes.length, body);

    // Nomi non validi
    body = `<p>Nei font i nomi dei glifi possono avere solo lettere senza accenti, numeri, punto, trattino e trattino basso, e non iniziare con un numero. Rinominali (tasto destro → Rinomina).</p><div class="names">${this.chips(report.invalidNames)}</div>`;
    html += section("Nomi di glifo non validi", report.invalidNames.length, body);

    // Larghezza negativa
    body = `<table>`;
    for (const g of negative) body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${escapeHTML(g.issues.negativeWidth.join(", "))}</td></tr>`;
    body += `</table>`;
    html += section("Larghezza negativa", negative.length, body);

    // Avvisi
    html += `<h3>Avvisi</h3><p>Non bloccano l'export, ma è meglio darci un'occhiata.</p>`;
    body = `<p>Hanno un carattere ma nessun disegno: scrivendo quel carattere si vedrà uno spazio vuoto.</p><div class="names">${this.chips(report.emptyWithUnicode)}</div>`;
    html += section("Glifi vuoti con un carattere", report.emptyWithUnicode.length, body, "warn");
    body = `<p>Le ancore servono a posizionare gli accenti (anche nel font esportato): è meglio che ogni master abbia le stesse.</p><table>`;
    for (const g of anchors) {
      body += `<tr><td class="g">${this.glyphChip(g.name)}</td><td>${g.issues.anchors
        .map((group) => `${this.masterLink(g.name, group)}: ${escapeHTML(group.text)}`)
        .join("<br>")}</td></tr>`;
    }
    body += `</table>`;
    html += section("Ancore diverse tra i master", anchors.length, body, "warn");
    body =
      `<p>Questi glifi non hanno un carattere, nessuna funzione OpenType li usa e nessun altro glifo li usa come componente: ` +
      `l'export di Fontra li lascia fuori dal font. Se sono alternative che vuoi nel font, servono le funzioni OpenType (per esempio ss01 o salt) che le usano.</p>` +
      `<div class="names">${this.chips(report.unreachable, 400, { tag: false })}</div>`;
    html += section("Glifi che non finiranno nel font", report.unreachable.length, body, "warn");
    if (report.errors.length) {
      body = `<table>${report.errors.map((e) => `<tr><td class="g">${this.glyphChip(e.name)}</td><td>${escapeHTML(e.message)}</td></tr>`).join("")}</table>`;
      html += section("Glifi che non si sono potuti controllare", report.errors.length, body);
    }

    // --- 3. Export ----------------------------------------------------------------
    html +=
      `<h3>Dopo</h3><p>Esporta con <b>File → Esporta come → OpenType (.otf)</b>: le curve restano quelle che hai disegnato. ` +
      `In TrueType (.ttf) le curve vengono convertite in curve quadratiche, con più punti e piccole approssimazioni.</p>`;

    if (this.host.canApply) {
      html +=
        `<div class="note"><label class="copy-check"><input type="checkbox" id="is-copy" ${this.isCopy ? "checked" : ""}>` +
        `<span>Sto lavorando su una <b>copia</b> del font${fileName ? ` (adesso è aperto «${escapeHTML(fileName)}»)` : ""}. ` +
        `Per farla: <b>File → Esporta come → .fontra</b>, poi apri la copia.</span></label></div>`;
    }

    $("#content").innerHTML = html;
    this.bind();
    this.updateApply();
  }

  bind() {
    const content = this.element.$("#content");
    const $ = this.element.$;
    for (const [id, key] of [["#opt-union", "union"], ["#opt-duplicates", "duplicates"], ["#opt-round", "round"]]) {
      $(id)?.addEventListener("change", (event) => {
        this.options[key] = event.target.checked;
        this.updateApply();
      });
    }
    $("#is-copy")?.addEventListener("change", (event) => {
      this.isCopy = event.target.checked;
      this.updateApply();
    });
    content.addEventListener("click", (event) => {
      const master = event.target.closest(".master");
      const chip = event.target.closest(".glyph");
      if (!master && !chip) return;
      if (master) this.host.openGlyph(master.dataset.glyph, Number(master.dataset.source));
      else this.host.openGlyph(chip.dataset.glyph, null);
      if (this.host.minimizeOnOpen) this.minimize();
    });
  }

  // Nell'editor la finestra si fa da parte per mostrare il glifo; un bottone
  // in basso a destra la riporta com'era
  minimize() {
    if (!this.element) return;
    this.element.hidden = true;
    window.removeEventListener("keydown", this.onKey, true);
    if (!this.restoreButton) {
      const button = document.createElement("button");
      button.textContent = "↩ Resoconto per l'export";
      button.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:1000;font:12px fontra-ui-regular,-apple-system,system-ui,sans-serif;" +
        "padding:6px 12px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer;box-shadow:0 3px 12px #0004";
      button.addEventListener("click", () => this.restore());
      document.body.appendChild(button);
      this.restoreButton = button;
    }
    this.restoreButton.hidden = false;
  }

  restore() {
    if (!this.element) return;
    this.element.hidden = false;
    this.restoreButton.hidden = true;
    window.addEventListener("keydown", this.onKey, true);
  }

  updateApply() {
    if (!this.element || !this.host.canApply) return;
    const button = this.element.$("#apply");
    if (!this.report) {
      button.disabled = true;
      return;
    }
    this.planned = planChanges(this.report, this.options);
    const n = this.planned.counts.glyphs;
    button.disabled = !n || !this.isCopy;
    button.textContent = n ? `Applica (${plural(n, "glifo", "glifi")})` : "Applica";
    button.title = !this.isCopy ? "Prima conferma qui sopra che stai lavorando su una copia" : "";
  }

  async apply() {
    if (!this.planned || this.planned.builder.isEmpty || !this.isCopy) return;
    const $ = this.element.$;
    const button = $("#apply");
    button.disabled = true;
    $("#msg").textContent = "Applico…";
    const { counts } = this.planned;
    const label = "Prepara per l'export";
    try {
      await this.host.apply(this.planned.builder, label);
      const parts = [];
      if (counts.union) parts.push(`${plural(counts.union, "glifo unito", "glifi uniti")}`);
      if (counts.decompose) parts.push(`${plural(counts.decompose, "glifo scomposto e unito", "glifi scomposti e uniti")}`);
      if (counts.duplicates) parts.push(`punti doppi tolti in ${plural(counts.duplicates, "glifo", "glifi")}`);
      if (counts.rounded) parts.push(`coordinate arrotondate in ${plural(counts.rounded, "glifo", "glifi")}`);
      const summary = `Fatto: ${parts.join(", ")}. ⌘Z per annullare.`;
      await this.analyze();
      if (this.element) this.element.$("#msg").textContent = summary;
    } catch (error) {
      console.error("[Prepara export]", error);
      if (this.element) $("#msg").textContent = `Non è stato possibile applicare: ${error?.message || error}`;
      button.disabled = false;
    }
  }

  reportText() {
    const r = this.report;
    if (!r) return "";
    const glyphs = [...r.glyphs.values()];
    const lines = [`Prepara per l'export — ${r.total} glifi`];
    const list = (title, items) => {
      lines.push("", `${title} (${items.length})`);
      for (const item of items) lines.push(`  ${item}`);
    };
    list("Da unire", glyphs.filter((g) => g.overlap === "fixable").map((g) => g.name + (g.plan.kind === "decompose" ? " (scomposto)" : "")));
    list(
      "Non unibili",
      glyphs
        .filter((g) => g.overlap === "incompatible")
        .map((g) => `${g.name}: ` + g.diagnosis.map((d) => `${d.masters.join(", ")} → ${d.text}${d.spots?.length ? " [" + d.spots.map(spotText).join("; ") + "]" : ""}`).join(" | "))
    );
    list("Master che non si corrispondono", glyphs.filter((g) => g.issues.incompatible).map((g) => `${g.name}: ` + g.issues.incompatible.map((d) => `${d.masters.join(", ")} → ${d.text}`).join(" | ")));
    list("Punti doppi", glyphs.filter((g) => g.duplicates).map((g) => `${g.name}: ${g.duplicates}`));
    list("Punti doppi solo in alcuni master", glyphs.filter((g) => g.issues.duplicatesSomeMasters).map((g) => `${g.name}: ${g.issues.duplicatesSomeMasters.join("; ")}`));
    list("Coordinate con decimali", glyphs.filter((g) => g.nonInteger).map((g) => g.name));
    list("Contorni aperti", glyphs.filter((g) => g.issues.open).map((g) => `${g.name}: ${g.issues.open.join(", ")}`));
    list("Componenti mancanti", glyphs.filter((g) => g.issues.missingComponents).map((g) => `${g.name}: ${g.issues.missingComponents.join(", ")}`));
    list("Unicode doppi", r.duplicateUnicodes.map((d) => `U+${d.cp.toString(16).toUpperCase().padStart(4, "0")}: ${d.glyphs.join(", ")}`));
    list("Nomi non validi", r.invalidNames);
    list("Larghezza negativa", glyphs.filter((g) => g.issues.negativeWidth).map((g) => `${g.name}: ${g.issues.negativeWidth.join(", ")}`));
    list("Vuoti con un carattere", r.emptyWithUnicode);
    list("Non finiranno nel font (nessun carattere, funzione OpenType o componente)", r.unreachable || []);
    list("Ancore diverse tra i master", glyphs.filter((g) => g.issues.anchors).map((g) => `${g.name}: ` + g.issues.anchors.map((d) => `${d.masters.join(", ")} → ${d.text}`).join(" | ")));
    if (r.errors.length) list("Errori", r.errors.map((e) => `${e.name}: ${e.message}`));
    return lines.join("\n");
  }

  async copyReport() {
    const text = this.reportText();
    const $ = this.element.$;
    try {
      await navigator.clipboard.writeText(text);
      $("#msg").textContent = "Resoconto copiato.";
    } catch (error) {
      // senza permesso per gli appunti: si mostra il testo da copiare a mano
      $("#content").insertAdjacentHTML(
        "afterbegin",
        `<textarea style="width:100%;height:160px;font:11px monospace">${escapeHTML(text)}</textarea>`
      );
      $("#msg").textContent = "Copia il testo qui sopra.";
    }
  }
}

// ---------------------------------------------------------------------------
// Menu: File → Prepara per l'export… (panoramica) / Controlla il font… (editor)
// ---------------------------------------------------------------------------

async function addToFileMenu(title, callback) {
  for (let i = 0; i < 100; i++) {
    const menuBar = document.querySelector(".top-bar-container menu-bar") || document.querySelector("menu-bar");
    const items = menuBar?.items;
    if (items?.length > 1) {
      // il primo menu è "Fontra", il secondo "File"
      const fileMenu = items[1];
      if (fileMenu.__prepareExport) return;
      fileMenu.__prepareExport = true;
      const original = fileMenu.getItems;
      fileMenu.getItems = () => [
        ...(original?.() || []),
        { title: "-" },
        { title, enabled: () => true, callback },
      ];
      return;
    }
    await sleep(200);
  }
  console.warn("[Prepara export] Menu File non trovato.");
}

// URL dell'editor con il glifo aperto in un certo punto dello spazio di design
async function editorURL(name, codePoints, userLocation) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace("/fontoverview.html", "/editor.html");
  const text = codePoints?.length ? (codePoints[0] === 0x2f ? "//" : String.fromCodePoint(codePoints[0])) : `/${name}`;
  const viewInfo = { location: userLocation || {}, text, selectedGlyph: { lineIndex: 0, glyphIndex: 0, isEditing: true } };
  const json = new TextEncoder().encode(JSON.stringify(viewInfo));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  url.hash = "#" + btoa(binary);
  return url.toString();
}

async function userLocationOfSource(fc, glyphName, sourceIndex) {
  if (sourceIndex === null || sourceIndex === undefined) return null;
  try {
    const varGlyph = await fc.getGlyph(glyphName);
    const location = varGlyph.getDenseSourceLocationForSource(varGlyph.sources[sourceIndex]);
    const fontAxisNames = new Set((fc.fontAxes || []).map((a) => a.name));
    const fontLocation = Object.fromEntries(Object.entries(location).filter(([k]) => fontAxisNames.has(k)));
    return fc.mapSourceLocationToUserLocation ? fc.mapSourceLocationToUserLocation(fontLocation) : fontLocation;
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Editor: solo controllo
// ---------------------------------------------------------------------------

class PrepareExportEditor {
  constructor(editor) {
    this.editor = editor;
    this.fc = editor.fontController;
    this.sc = editor.sceneController;
    addToFileMenu(MENU_TITLE_EDITOR, () => this.openDialog());
    this.linkOverviewWindows();
  }

  openDialog() {
    new PrepareExportDialog({
      fc: this.fc,
      canApply: false,
      minimizeOnOpen: true,
      openGlyph: (name, sourceIndex) => this.openGlyph(name, sourceIndex),
    }).open();
  }

  async openGlyph(name, sourceIndex) {
    const cp = this.fc.glyphMap[name]?.[0];
    const info = cp !== undefined ? { glyphName: name, character: String.fromCodePoint(cp) } : { glyphName: name };
    const settings = this.sc.sceneSettings;
    settings.characterLines = [[info]];
    await sleep(150);
    settings.selectedGlyph = { lineIndex: 0, glyphIndex: 0, isEditing: true };
    if (sourceIndex !== null && sourceIndex !== undefined) {
      await sleep(100);
      try {
        await this.sc.setLocationFromSourceIndex(sourceIndex);
      } catch (error) {
        console.warn("[Prepara export]", error);
      }
    }
  }

  // Fontra carica i plugin solo nell'editor: il modulo si installa anche nella
  // panoramica che ha aperto l'editor (o che si apre dal menu Font).
  linkOverviewWindows() {
    this.overviewWindows = new Set();
    try {
      if (window.opener) this.overviewWindows.add(window.opener);
    } catch (error) {
      // finestra di un altro sito: ignorata
    }
    const originalOpen = window.open;
    const windows = this.overviewWindows;
    const plugin = this;
    window.open = function (...args) {
      const opened = originalOpen.apply(this, args);
      if (opened && /fontoverview/.test(`${args[0] ?? ""} ${args[1] ?? ""}`)) {
        windows.add(opened);
        setTimeout(() => plugin.installInOverviews(), 500);
      }
      return opened;
    };
    this.installInOverviews();
    setInterval(() => this.installInOverviews(), OVERVIEW_POLL_MS);
  }

  installInOverviews() {
    const project = new URL(window.location.href).searchParams.get("project");
    for (const win of this.overviewWindows) {
      try {
        if (!win || win.closed) {
          this.overviewWindows.delete(win);
          continue;
        }
        if (win[OVERVIEW_KEY] || !win.fontOverviewController) continue;
        if (new URL(win.location.href).searchParams.get("project") !== project) continue;
        win[OVERVIEW_KEY] = "loading";
        const script = win.document.createElement("script");
        script.type = "module";
        script.textContent =
          `import(${JSON.stringify(import.meta.url)})` +
          `.then((m) => m.startOverview(window.fontOverviewController))` +
          `.catch((e) => console.error("[Prepara export]", e));`;
        win.document.head.appendChild(script);
      } catch (error) {
        // finestra non raggiungibile
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Panoramica: controllo e correzioni, con ⌘Z
// ---------------------------------------------------------------------------

class PrepareExportOverview {
  constructor(controller) {
    this.controller = controller;
    this.fc = controller.fontController;
    addToFileMenu(MENU_TITLE, () => this.openDialog());
    this.installChunkedUndo();
  }

  openDialog() {
    new PrepareExportDialog({
      fc: this.fc,
      canApply: !this.fc.readOnly,
      apply: (builder, label) => this.post(builder, label),
      openGlyph: (name, sourceIndex) => this.openGlyph(name, sourceIndex),
    }).open();
  }

  async openGlyph(name, sourceIndex) {
    const location =
      (await userLocationOfSource(this.fc, name, sourceIndex)) ||
      this.controller.fontOverviewSettings?.fontLocationUser ||
      {};
    try {
      window.open(await editorURL(name, this.fc.glyphMap[name] || [], location));
    } catch (error) {
      console.warn("[Prepara export]", error);
    }
  }

  async post(builder, label) {
    const { change, rollbackChange } = builder.build(label);
    await this.fc.applyChange(change);
    const controller = this.controller;
    if (typeof controller.postChange === "function" && controller.undoStack) {
      if (countGlyphs(change) <= GLYPHS_PER_CHUNK) {
        await controller.postChange({ change, rollbackChange }, label);
      } else {
        controller.undoStack.pushUndoRecord({ change, rollbackChange, info: { label } });
        await postChunked(this.fc, change, label);
      }
    } else {
      await postChunked(this.fc, change, label);
    }
  }

  // ⌘Z delle modifiche grandi: anche l'annullamento parte a blocchi
  installChunkedUndo() {
    const controller = this.controller;
    const original = controller.doUndoRedo;
    if (typeof original !== "function" || !controller.undoStack) return;
    controller.doUndoRedo = async (isRedo) => {
      const top = controller.undoStack.getTopUndoRedoRecord(isRedo);
      const isOurs = top?.change?.[META] && countGlyphs(top.change) > GLYPHS_PER_CHUNK;
      if (!isOurs) return original.call(controller, isRedo);
      const record = controller.undoStack.popUndoRedoRecord(isRedo);
      const change = isRedo ? record.change : record.rollbackChange;
      await this.fc.applyChange(change);
      await postChunked(this.fc, change, record.info.label);
    };
  }
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

export function start(editor, pluginPath) {
  if (editor[EDITOR_KEY]) return;
  editor[EDITOR_KEY] = new PrepareExportEditor(editor);
}

export function startOverview(controller) {
  if (!controller || window[OVERVIEW_KEY] === true) return;
  window[OVERVIEW_KEY] = true;
  controller[OVERVIEW_KEY] = new PrepareExportOverview(controller);
}

// Per i test
export {
  FontAnalyzer,
  PrepareExportDialog,
  planChanges,
  readContours,
  packContours,
  matchAllContours,
  duplicateIndices,
  dedupeContours,
  normalizeDirection,
};
