// WorldBuilder · DerethMaps Enhanced — Leaflet frontend.
//
// Plain ES6, no build step. Loads JSONP-style data files via dynamic
// <script> tags so the dist works from file:// without fetch().
//
// World coordinates: +X east, +Y north. World extent 49,152 × 49,152 wu.
// We use L.CRS.Simple with latLng = (worldY, worldX). Map y-flip is handled
// by Leaflet's default transformation.

(function () {
  'use strict';

  // ── Globals populated by JSONP loaders ────────────────────────────────
  // The orchestrator emits desc/<lbHex>.js as `LOAD_DESC('<hex>', {...});`
  // and dungeons/<lbHex>.js as `LOAD_DUNGEON(...)`. Each callback stuffs
  // the payload into a registry keyed by lb hex.
  const DESC = Object.create(null);
  const DUNGEON = Object.create(null);
  const OVERLAY_DATA = Object.create(null);
  const SCRIPT_PROMISES = Object.create(null);

  window.LOAD_DESC = function (lbHex, payload) { DESC[lbHex] = payload; };
  window.LOAD_DUNGEON = function (lbHex, payload) { DUNGEON[lbHex] = payload; };
  window.LOAD_OVERLAY = function (name, payload) { OVERLAY_DATA[name] = payload; };

  const WORLD_EXTENT = 49152;
  const LB_SIZE = 192;
  const TILE_PX = 256;

  // ── Boot ──────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  let map = null;
  let activeProject = null;
  let activeProjectMeta = null;
  let terrainLayer = null;        // terrain raster + roads only (always visible)
  let objectsGlyphLayer = null;   // glyph-mode object overlay (hidden in floor mode)
  let objectLayer = null;         // sprite-mode object overlay at z>=11 (hidden in floor mode)
  let exteriorLayer = null;       // legacy combined layer; loaded only if dist lacks split layers
  let floorImageOverlay = null;

  function boot() {
    if (typeof MANIFEST === 'undefined') {
      setStatus('manifest.js missing — orchestrator output incomplete.');
      return;
    }
    populateProjectPicker();
    const initial = parseUrlParams();
    const projectSlug = initial.project || MANIFEST.defaultProject ||
      (MANIFEST.projects[0] && MANIFEST.projects[0].slug);
    if (!projectSlug) {
      setStatus('No projects in manifest.');
      return;
    }
    document.getElementById('project-select').value = projectSlug;
    initMap();
    loadProject(projectSlug, initial);

    // Live overlay hook: a dist-root `overlays/dynamic_players.js` (NOT
    // per-project — this overlay applies to whichever project is loaded,
    // matching the future "live admin viewing all projects" use case) gets
    // script-loaded if present and silently no-ops when absent. Path stays
    // at dist-root by design; do not change to projects/<slug>/.
    loadScript('overlays/dynamic_players.js').catch(function () { /* ignore */ });

    // Sibling gallery probe (emit-static-site --gallery). HEAD-or-fail
    // probe is the cheapest way to detect the gallery without baking a
    // flag into manifest.js. fetch() works under HTTP serving; from
    // file:// we leave the link hidden because the network probe can't
    // resolve and a dead link would be worse than a missing one.
    if (window.fetch) {
      fetch('gallery/index.html', { method: 'HEAD' }).then(function (r) {
        if (r.ok) {
          var a = document.getElementById('gallery-link');
          if (a) a.hidden = false;
        }
      }).catch(function () { /* gallery not emitted; stay hidden */ });
    }
  }

  // ── Project switcher ──────────────────────────────────────────────────

  function populateProjectPicker() {
    const sel = document.getElementById('project-select');
    sel.innerHTML = '';
    MANIFEST.projects.forEach(function (p) {
      const opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.name + ' (' + p.slug + ')';
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      const params = new URLSearchParams(window.location.search);
      params.set('project', sel.value);
      // Clear view-position params when switching projects.
      params.delete('z'); params.delete('x'); params.delete('y'); params.delete('floor');
      window.location.search = params.toString();
    });
  }

  // ── Map init ──────────────────────────────────────────────────────────

  function initMap() {
    // Why: L.CRS.Simple's default transformation is 1:1 (1 latLng unit = 1
    // pixel at z=0). With a 49,152-unit world, that puts the world at
    // 49,152 px = 192 tiles per side at z=0 — Leaflet then asks for tile
    // coords that don't match our emitter's pyramid (which writes 1 tile
    // per side at z=0 covering the whole world). Compress the projection
    // so the world fits in one 256-px tile at z=0; then at z=N there are
    // 2^N tiles per side, exactly matching the emitter.
    //
    // Transformation params: pixel.x = scale * (a*lng + b);
    //                        pixel.y = scale * (c*lat + d).
    //  a = TILE_PX/WORLD_EXTENT puts lng=0..49152 into px x=0..256 at z=0.
    //  c = -a flips Y so world+Y (north) reads as up; the d=TILE_PX
    //  offset shifts the resulting negative range back into [0, 256], so
    //  Leaflet asks for non-negative tile y coords that match our emitter.
    const pxPerWuAtZ0 = TILE_PX / WORLD_EXTENT;
    const crs = L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(pxPerWuAtZ0, 0, -pxPerWuAtZ0, TILE_PX),
    });
    map = L.map('map', {
      crs: crs,
      minZoom: 3, maxZoom: 12,
      zoomSnap: 1, zoomDelta: 1,
      attributionControl: false,
    });
    // World bounds in latLng (lat=worldY, lng=worldX). Leaflet's projection
    // sends north (high worldY) to negative pixel.y → screen-up; the custom
    // transformation above preserves that, so worldY+ reads as up.
    const bounds = L.latLngBounds(L.latLng(0, 0), L.latLng(WORLD_EXTENT, WORLD_EXTENT));
    map.setMaxBounds(bounds.pad(0.1));

    map.on('mousemove', onMouseMove);
    map.on('click', onClick);
    map.on('moveend zoomend', onViewChanged);
  }

  // ── Project load ──────────────────────────────────────────────────────

  function loadProject(slug, initial) {
    activeProject = slug;
    setStatus('Loading project: ' + slug + '…');
    // Each project's meta lives at projects/<slug>/meta.js, exposing the
    // global `PROJECT_<sanitizedSlug>`. We script-load it then look up by
    // sanitized name.
    const metaPath = 'projects/' + slug + '/meta.js';
    loadScript(metaPath).then(function () {
      const safe = slug.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
      activeProjectMeta = window['PROJECT_' + safe];
      if (!activeProjectMeta) {
        setStatus('meta.js loaded but PROJECT_' + safe + ' is undefined.');
        return;
      }
      // Bail out before constructing any tile/CRS layer if the emitter and
      // frontend disagree on the pixel-to-world contract. A silent drift
      // here puts the entire world in the wrong place.
      if (!assertCoordSystem(activeProjectMeta)) return;
      projectLbSet = new Set(activeProjectMeta.lbList);
      installTileLayers(slug);
      installOverlays(slug);
      restoreOrInitView(initial);
      setStatus('Project: ' + slug + ' · ' + activeProjectMeta.lbList.length +
        ' LBs · ' + activeProjectMeta.dungeonLbs.length + ' dungeons');
    }, function (err) {
      setStatus('Failed to load ' + metaPath + ': ' + err);
    });
  }

  // ── Boot-time assertions ──────────────────────────────────────────────

  // Diagnostics issues collected during boot. Surfaced via the banner and
  // (in O9) via the diagnostics overlay panel.
  const BOOT_ISSUES = [];

  function recordBootIssue(severity, source, message) {
    BOOT_ISSUES.push({ severity: severity, source: source, message: message });
    if (severity === 'error') console.error('[' + source + '] ' + message);
    else console.warn('[' + source + '] ' + message);
  }

  function showBootBanner() {
    const el = document.getElementById('boot-banner');
    if (!el) return;
    const errors = BOOT_ISSUES.filter(function (i) { return i.severity === 'error'; });
    if (!errors.length) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = errors.map(function (i) {
      return '[' + i.source + '] ' + i.message;
    }).join('\n');
  }

  // Returns true when the emitter's coordSystem matches the frontend's
  // constants. Returns false (and posts an error banner) on any mismatch
  // so the caller can skip layer construction.
  function assertCoordSystem(meta) {
    const cs = meta && meta.coordSystem;
    if (!cs) {
      // Tolerate older dists that pre-date O1 — record as a warning so the
      // diagnostics panel surfaces it but boot still proceeds.
      recordBootIssue('warning', 'coordSystem',
        'meta.js has no coordSystem block (older emitter); skipping assertion.');
      showBootBanner();
      return true;
    }
    const expected = {
      worldExtentWu: WORLD_EXTENT,
      tilePx: TILE_PX,
      lbWu: LB_SIZE,
      pxPerWuAtZ0: TILE_PX / WORLD_EXTENT,
      projectionVersion: 1,
    };
    const mismatches = [];
    Object.keys(expected).forEach(function (k) {
      const got = cs[k];
      const want = expected[k];
      const equal = (typeof want === 'number')
        ? Math.abs(got - want) <= 1e-12
        : got === want;
      if (!equal) mismatches.push(k + ' expected=' + want + ' got=' + got);
    });
    if (mismatches.length) {
      recordBootIssue('error', 'coordSystem',
        'tile-coordinate contract mismatch — emitter and frontend disagree:\n  ' +
        mismatches.join('\n  '));
      showBootBanner();
      setStatus('Coord-system mismatch — tile rendering aborted.');
      return false;
    }
    return true;
  }

  function installTileLayers(slug) {
    if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
    if (objectsGlyphLayer) { map.removeLayer(objectsGlyphLayer); objectsGlyphLayer = null; }
    if (objectLayer) { map.removeLayer(objectLayer); objectLayer = null; }
    if (exteriorLayer) { map.removeLayer(exteriorLayer); exteriorLayer = null; }

    const proj = MANIFEST.projects.find(function (p) { return p.slug === slug; });
    // Explicit null-check (instead of `||`) so a legitimate 0 isn't treated
    // as "missing" and replaced by the default. Older dists may emit no
    // min/max zoom on the manifest — keep the historical 3..12 default in
    // that case.
    const minZ = (proj && proj.minZoom != null) ? proj.minZoom : 3;
    const maxZ = (proj && proj.maxZoom != null) ? proj.maxZoom : 12;
    // Apply per-project zoom limits to the map itself, not just the tile
    // layers. Without this the user could zoom out to 3 on a project that
    // only ships z=9..12 tiles and see broken/empty raster output.
    if (typeof map.setMinZoom === 'function') map.setMinZoom(minZ);
    if (typeof map.setMaxZoom === 'function') map.setMaxZoom(maxZ);
    const worldBounds = L.latLngBounds(L.latLng(0, 0), L.latLng(WORLD_EXTENT, WORLD_EXTENT));

    // terrain/  — always visible. Floor mode keeps this so the player has
    // surface context (rivers, hills, roads) while inspecting an interior.
    terrainLayer = L.tileLayer('projects/' + slug + '/tiles/terrain/{z}/{x}/{y}.png', {
      tileSize: TILE_PX, minZoom: minZ, maxZoom: maxZ, noWrap: true,
      bounds: worldBounds, errorTileUrl: '', zIndex: 100,
    });
    terrainLayer.addTo(map);

    // objects/ — glyph-mode object overlay, transparent terrain. Hidden in
    // floor mode so building rectangles (the "roofs" the user was seeing
    // through the floor plan) disappear cleanly.
    objectsGlyphLayer = L.tileLayer('projects/' + slug + '/tiles/objects/{z}/{x}/{y}.png', {
      tileSize: TILE_PX, minZoom: minZ, maxZoom: maxZ, noWrap: true,
      bounds: worldBounds, errorTileUrl: '', zIndex: 200,
    });
    objectsGlyphLayer.addTo(map);

    // object/ — sprite-mode (textured). Now pyramided to all zooms (not
    // just z>=11) so building textures appear at moderate zoom too.
    // Loaded eagerly; if the project lacks a sprite atlas the tile dir
    // simply 404s and the underlying objects-glyph layer remains visible.
    objectLayer = L.tileLayer('projects/' + slug + '/tiles/object/{z}/{x}/{y}.png', {
      tileSize: TILE_PX, minZoom: minZ, maxZoom: maxZ, noWrap: true,
      bounds: worldBounds, errorTileUrl: '', opacity: 1.0, zIndex: 250,
    });
    objectLayer.addTo(map);
    map.on('zoomend', updateObjectLayerVisibility);
    updateObjectLayerVisibility();
  }

  function updateObjectLayerVisibility() {
    // Sprite tier now pyramids to every zoom — keep it added unless the
    // floor selector explicitly removes it. Kept for hook compatibility.
    if (!objectLayer) return;
    if (!map.hasLayer(objectLayer)) objectLayer.addTo(map);
  }

  // ── Overlays ──────────────────────────────────────────────────────────

  function installOverlays(slug) {
    // Prefer the authoritative list emitted into meta.js (Phase O+: drives
    // overlay iteration from a single source so adding a gazetteer in
    // StaticSiteEmitter doesn't silently fail to render here). Fall back to
    // the historical hardcoded list for older dists that pre-date the
    // overlayList field.
    const overlayNames = (activeProjectMeta && Array.isArray(activeProjectMeta.overlayList) &&
                          activeProjectMeta.overlayList.length)
      ? activeProjectMeta.overlayList
      : ['towns', 'pois', 'spawns', 'creatures', 'npcs', 'housing', 'grid', 'diagnostics'];
    const layers = {};
    let pending = overlayNames.length;
    overlayNames.forEach(function (name) {
      const path = 'projects/' + slug + '/overlays/' + name + '.js';
      loadScript(path).then(function () {
        const data = OVERLAY_DATA[name];
        if (data === undefined) {
          recordBootIssue('warning', 'overlay:' + name,
            'overlay file loaded but LOAD_OVERLAY callback didn\'t fire (corrupt JSONP).');
        } else if (name === 'diagnostics') {
          // Don't render diagnostics on the map; surface them in the panel.
          mergeBackendDiagnostics(data);
        } else {
          const layer = renderOverlay(name, data);
          if (layer) {
            layers[name] = layer;
            rebuildLayerControl(layers);
          }
        }
        if (--pending === 0) finishBootDiagnostics();
      }, function () {
        // Missing overlay file. With the O6+O7 stub-emit policy, this
        // shouldn't happen for any of the canonical overlays — flag it
        // as an error so the diagnostic surface stays factual.
        recordBootIssue('warning', 'overlay:' + name,
          'overlay file not found at ' + path + ' (emitter should write a stub).');
        if (--pending === 0) finishBootDiagnostics();
      });
    });
  }

  function mergeBackendDiagnostics(payload) {
    if (!payload || !Array.isArray(payload.issues)) return;
    payload.issues.forEach(function (i) {
      recordBootIssue(i.severity || 'info', 'emitter:' + (i.overlay || 'unknown'),
        i.message || '(no message)');
    });
  }

  // After all overlays have either loaded or failed, run the spawn-index
  // assertion (which depends on `spawns` data) and render the persistent
  // diagnostics panel footer.
  function finishBootDiagnostics() {
    assertSpawnIndex();
    showBootBanner();
    renderDiagnosticsFooter();
  }

  // Verify every spawn-overlay record's landblockId hex maps back to an
  // LB the project actually shipped. A drift here means the spawn data
  // was generated against a different project than the meta — render
  // would silently put markers in the wrong place.
  function assertSpawnIndex() {
    const data = OVERLAY_DATA['spawns'];
    if (!data || !activeProjectMeta) return;
    let bad = 0;
    let total = 0;
    Object.keys(data).forEach(function (key) {
      // Spawns overlay schema is { "0xLLLL": [records...] }
      if (!Array.isArray(data[key])) return;
      total += data[key].length;
      if (!projectLbSet || !projectLbSet.has(key)) bad += data[key].length;
    });
    if (bad > 0) {
      recordBootIssue('warning', 'spawnIndex',
        bad + ' of ' + total + ' spawn records reference LBs not in the project lbList.');
    }
  }

  // Persistent footer in the describe panel: always says how many issues
  // boot found. Even "0 issues" is rendered so the user knows the panel
  // is alive.
  function renderDiagnosticsFooter() {
    const panel = document.getElementById('describe-panel');
    if (!panel) return;
    const errors = BOOT_ISSUES.filter(function (i) { return i.severity === 'error'; }).length;
    const warnings = BOOT_ISSUES.filter(function (i) { return i.severity === 'warning'; }).length;
    const infos = BOOT_ISSUES.filter(function (i) { return i.severity === 'info'; }).length;
    const total = BOOT_ISSUES.length;
    const summary = total === 0 ? '0 issues'
      : (errors + ' errors · ' + warnings + ' warnings · ' + infos + ' info');
    let footer = document.getElementById('diagnostics-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.id = 'diagnostics-footer';
      panel.appendChild(footer);
    }
    let html = '<div class="panel-section diagnostics-section"><h3>Diagnostics</h3>';
    html += '<p class="diagnostics-summary">' + summary + '</p>';
    if (total > 0) {
      html += '<ul class="diagnostics-list">';
      BOOT_ISSUES.slice(0, 12).forEach(function (i) {
        html += '<li class="sev-' + i.severity + '"><strong>' + escapeHtml(i.source) +
          '</strong>: ' + escapeHtml(i.message) + '</li>';
      });
      if (total > 12) html += '<li>… +' + (total - 12) + ' more (see console)</li>';
      html += '</ul>';
    }
    html += '</div>';
    footer.innerHTML = html;
  }

  let layerControl = null;
  function rebuildLayerControl(layers) {
    if (layerControl) map.removeControl(layerControl);
    layerControl = L.control.layers({}, layers, { collapsed: false, position: 'topright' });
    layerControl.addTo(map);
  }

  // Boot-time grid-config assertion. The emitter writes a config-only
  // payload into the grid overlay (landblockSize/worldExtent/gridSize); we
  // verify it matches our constants here so a future drift in either side
  // surfaces as a diagnostic instead of an off-by-N visual bug. Mirrors the
  // assertCoordSystem pattern.
  function assertGridConfig(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const expected = { landblockSize: LB_SIZE, worldExtent: WORLD_EXTENT, gridSize: 256 };
    Object.keys(expected).forEach(function (k) {
      if (data[k] !== undefined && data[k] !== expected[k]) {
        recordBootIssue('warning', 'gridConfig',
          'grid overlay ' + k + ' expected=' + expected[k] + ' got=' + data[k]);
      }
    });
  }

  function renderOverlay(name, data) {
    // Each overlay carries a different shape; render conservatively.
    // Towns: list of { name, x, y, ... }. Grid: a config-only payload that
    // we assert against frontend constants and then render synthetically.
    const group = L.layerGroup();
    if (name === 'grid') {
      assertGridConfig(data);
      // Light landblock-grid lines every 192 wu, drawn from frontend
      // constants (the emitter's payload is contract-only — we don't
      // consume its values).
      const gridLayer = L.layerGroup();
      for (let i = 1; i < 256; i++) {
        const x = i * LB_SIZE;
        gridLayer.addLayer(L.polyline(
          [[0, x], [WORLD_EXTENT, x]],
          { color: '#666', weight: 0.5, opacity: 0.35, interactive: false }));
        gridLayer.addLayer(L.polyline(
          [[x, 0], [x, WORLD_EXTENT]],
          { color: '#666', weight: 0.5, opacity: 0.35, interactive: false }));
      }
      return gridLayer;
    }
    // Spawn overlay carries records keyed by hex landblock id. Flatten
    // for marker rendering.
    let records;
    if (name === 'spawns' && data && typeof data === 'object' && !Array.isArray(data)) {
      records = [];
      Object.keys(data).forEach(function (lbKey) {
        if (Array.isArray(data[lbKey])) {
          data[lbKey].forEach(function (r) {
            r.__lbHex = lbKey;
            records.push(r);
          });
        }
      });
    } else {
      records = Array.isArray(data) ? data : (data.entries || data.items);
    }
    if (Array.isArray(records)) {
      records.forEach(function (rec) {
        const x = rec.x != null ? rec.x : (rec.position ? rec.position.x : null);
        const y = rec.y != null ? rec.y : (rec.position ? rec.position.y : null);
        if (x == null || y == null) return;
        const synthetic = rec.isSynthetic === true || rec.is_synthetic === true;
        const m = L.circleMarker([y, x], {
          radius: 4, color: overlayColor(name), fillOpacity: synthetic ? 0.4 : 0.85,
          weight: 1, dashArray: synthetic ? '2 2' : null,
        });
        const title = rec.name || rec.title || rec.label;
        if (title) m.bindTooltip(title + (synthetic ? ' (synthetic)' : ''), { sticky: true });
        m.on('click', function (e) {
          openPlacementPanel(name, rec);
          // Stop propagation so the map's onClick (LB describe) doesn't fire too.
          if (e.originalEvent && e.originalEvent.stopPropagation) e.originalEvent.stopPropagation();
        });
        group.addLayer(m);
      });
    }
    return group;
  }

  // Shared panel render for any clicked overlay record (spawn, town, POI,
  // creature, NPC, housing). Sprite/glyph click on the tile pyramid keeps
  // its existing renderObjectPanel path; this is the overlay-marker path.
  function openPlacementPanel(overlayName, rec) {
    const panel = document.getElementById('describe-panel');
    if (!panel) return;
    const html = [];
    html.push('<div class="panel-section"><h3>' + overlayName + '</h3>');
    const title = rec.name || rec.title || rec.label || ('wcid ' + (rec.wcid || '?'));
    html.push('<p><strong>' + escapeHtml(title) + '</strong></p>');
    if (rec.acpediaTitle && rec.acpediaTitle !== title)
      html.push('<p>Acpedia: ' + escapeHtml(rec.acpediaTitle) +
        (rec.acpediaTier ? ' <em>(' + escapeHtml(rec.acpediaTier) + ')</em>' : '') + '</p>');
    if (rec.category) html.push('<p>Category: ' + escapeHtml(rec.category) + '</p>');
    if (rec.generator) html.push('<p>Generator: ' + escapeHtml(rec.generator) + '</p>');
    if (rec.wcid != null) html.push('<p>Wcid: ' + rec.wcid + '</p>');
    if (rec.weenieType != null) html.push('<p>WeenieType: ' + rec.weenieType + '</p>');
    const x = rec.x != null ? rec.x : (rec.position ? rec.position.x : null);
    const y = rec.y != null ? rec.y : (rec.position ? rec.position.y : null);
    const z = rec.z != null ? rec.z : (rec.position ? rec.position.z : null);
    if (x != null && y != null) {
      html.push('<p>Position: (' + Number(x).toFixed(2) + ', ' + Number(y).toFixed(2) +
        (z != null ? ', ' + Number(z).toFixed(2) : '') + ')</p>');
    }
    if (rec.cell != null) html.push('<p>Cell: ' + rec.cell + '</p>');
    if (rec.__lbHex) html.push('<p>Landblock: ' + rec.__lbHex + '</p>');
    if (rec.isSynthetic === true || rec.is_synthetic === true)
      html.push('<p><em>This record is synthetic — position or category was reconstructed.</em></p>');
    html.push('</div>');
    panel.innerHTML = html.join('');
    // Re-append the diagnostics footer so it stays sticky after a click.
    renderDiagnosticsFooter();
  }

  function overlayColor(name) {
    return ({
      towns: '#e6b04f',
      pois: '#6ec8e0',
      spawns: '#c0392b',
      housing: '#a06ed4',
      diagnostics: '#e64f4f',
    })[name] || '#aaaaaa';
  }

  // ── Hover/click describe panel ────────────────────────────────────────

  let hoverDebounce = 0;
  // Lookup index of LBs the project actually has desc files for. Built once
  // at project-load time so onMouseMove can skip prefetches for LBs that
  // are guaranteed-404 — saves a console warning per cursor LB.
  let projectLbSet = null;

  function onMouseMove(e) {
    const ll = e.latlng;
    const lbHex = lbHexFor(ll);
    if (lbHex == null) return;
    setStatus('LB ' + lbHex + ' · z=' + map.getZoom() + ' · ' +
      'world (' + Math.round(ll.lng) + ', ' + Math.round(ll.lat) + ')');
    // Skip prefetch for LBs the project doesn't ship a desc for; otherwise
    // every mousemove over the world's empty area generates a 404.
    if (projectLbSet && !projectLbSet.has(lbHex)) return;
    if (!DESC[lbHex] && !SCRIPT_PROMISES[descPath(lbHex)]) {
      clearTimeout(hoverDebounce);
      hoverDebounce = setTimeout(function () {
        loadScript(descPath(lbHex)).catch(function () { /* missing → fine */ });
      }, 150);
    }
  }

  function onClick(e) {
    const ll = e.latlng;
    const lbHex = lbHexFor(ll);
    if (lbHex == null) return;
    loadScript(descPath(lbHex)).then(function () {
      const obj = nearestObjectAt(lbHex, ll);
      if (obj) {
        renderObjectPanel(lbHex, obj);
      } else {
        renderDescribePanel(lbHex);
      }
    }, function () {
      renderDescribePanelFallback(lbHex);
    });
  }

  // Pixel-tolerant nearest-neighbor over the LB's objectIndex. Tolerance
  // scales with zoom — at z=12 a click within ~1 wu wins; at z=8 we fall
  // back to LB-level description because objects aren't individually
  // distinguishable at that scale.
  function nearestObjectAt(lbHex, latLng) {
    const data = DESC[lbHex];
    if (!data || !data.body || !data.body.objectIndex) return null;
    const z = map.getZoom();
    if (z < 10) return null;  // Below z=10, sprites blend; use LB-level info.
    // Tolerance in world units: roughly half a glyph at the current zoom.
    // pxPerWorldUnit at z = 256 / (49152 / 2^z) = 2^z / 192. Aim for ~6 px.
    const pxPerWu = Math.pow(2, z) / 192;
    const tolWu = 6 / pxPerWu;
    const tolSq = tolWu * tolWu;
    const cx = latLng.lng, cy = latLng.lat;
    let best = null, bestSq = tolSq;
    data.body.objectIndex.forEach(function (o) {
      const dx = o.x - cx, dy = o.y - cy;
      const dsq = dx * dx + dy * dy;
      if (dsq < bestSq) { bestSq = dsq; best = o; }
    });
    return best;
  }

  function renderObjectPanel(lbHex, obj) {
    const panel = document.getElementById('describe-panel');
    const data = DESC[lbHex];
    const html = [];
    html.push('<div class="panel-section"><h3>Object</h3>');
    html.push('<p><strong>' + escapeHtml(obj.modelId) + '</strong> (' + obj.type + ')</p>');
    html.push('<p>Category: ' + escapeHtml(obj.category || 'Unknown') + '</p>');
    html.push('<p>Position: (' + obj.x.toFixed(2) + ', ' + obj.y.toFixed(2) +
      ', ' + obj.z.toFixed(2) + ')</p>');
    html.push('<p>Index: ' + obj.index + ' in landblock ' + lbHex + '</p></div>');

    if (obj.namedIndex != null && data && data.body && data.body.namedObjects) {
      const named = data.body.namedObjects[obj.namedIndex];
      if (named) {
        html.push('<div class="panel-section"><h3>Named</h3>');
        html.push('<p><strong>' + escapeHtml(named.acpediaTitle) + '</strong>' +
          (named.tier ? ' <em>(' + named.tier + ')</em>' : '') + '</p>');
        if (named.weenieName && named.weenieName !== named.acpediaTitle)
          html.push('<p>Weenie: ' + escapeHtml(named.weenieName) + '</p>');
        if (named.acpediaCategories && named.acpediaCategories.length)
          html.push('<p>Categories: ' + named.acpediaCategories.map(escapeHtml).join(', ') + '</p>');
        if (named.acpediaDescription)
          html.push('<p>' + escapeHtml(named.acpediaDescription) + '</p>');
        html.push('</div>');
      }
    }

    html.push('<div class="panel-section"><h3>Landblock</h3>');
    html.push('<p>' + lbHex + ' at (' + data.lbX + ', ' + data.lbY + ')</p></div>');
    panel.innerHTML = html.join('');
    renderDiagnosticsFooter();
  }

  function descPath(lbHex) {
    return 'projects/' + activeProject + '/desc/' + lbHex + '.js';
  }

  function renderDescribePanel(lbHex) {
    const panel = document.getElementById('describe-panel');
    const data = DESC[lbHex];
    if (!data) { renderDescribePanelFallback(lbHex); return; }
    const html = [];
    html.push('<div class="panel-section"><h3>Landblock</h3>');
    html.push('<p><strong>' + lbHex + '</strong> at (' + data.lbX + ', ' + data.lbY + ')</p></div>');
    if (data.context) {
      html.push('<div class="panel-section"><h3>Context</h3>');
      const c = data.context;
      const fields = [];
      if (c.townName) fields.push('Town: ' + c.townName);
      if (c.regionName) fields.push('Region: ' + c.regionName);
      if (c.biome) fields.push('Biome: ' + c.biome);
      if (c.dominantArchitecture) fields.push('Architecture: ' + c.dominantArchitecture);
      if (c.structureCount != null) fields.push('Structures: ' + c.structureCount);
      html.push('<p>' + fields.join(' · ') + '</p></div>');
    }
    if (data.terrain && data.terrain.summary) {
      html.push('<div class="panel-section"><h3>Terrain</h3>');
      html.push('<p>' + escapeHtml(data.terrain.summary) + '</p></div>');
    }
    if (data.body && data.body.objectTotal != null) {
      html.push('<div class="panel-section"><h3>Body</h3>');
      html.push('<p>' + data.body.objectTotal + ' objects · ' +
        (data.body.structures || []).length + ' structures · ' +
        (data.body.namedObjects || []).length + ' named</p></div>');
    }
    if (data.verbal) {
      html.push('<div class="panel-section"><h3>Verbal</h3>');
      html.push('<p>' + escapeHtml(data.verbal) + '</p></div>');
    }
    panel.innerHTML = html.join('');
    renderDiagnosticsFooter();
  }

  function renderDescribePanelFallback(lbHex) {
    document.getElementById('describe-panel').innerHTML =
      '<div class="panel-section"><h3>Landblock</h3>' +
      '<p>' + lbHex + ' (no description available)</p></div>';
    renderDiagnosticsFooter();
  }

  // ── Floor selector ────────────────────────────────────────────────────

  function clearFloor() {
    if (floorImageOverlay) { map.removeLayer(floorImageOverlay); floorImageOverlay = null; }
    if (terrainLayer) terrainLayer.setOpacity(1);
    if (objectsGlyphLayer && !map.hasLayer(objectsGlyphLayer)) objectsGlyphLayer.addTo(map);
    if (objectLayer) updateObjectLayerVisibility();
  }

  function updateFloorSelector(centerLbHex) {
    const selector = document.getElementById('floor-selector');
    if (!activeProjectMeta || !centerLbHex) {
      selector.classList.remove('active');
      selector.innerHTML = '';
      clearFloor();
      return;
    }
    const isDungeon = activeProjectMeta.dungeonLbs.indexOf(centerLbHex) >= 0;
    if (!isDungeon || map.getZoom() < 10) {
      selector.classList.remove('active');
      clearFloor();
      return;
    }
    const floors = activeProjectMeta.floorCounts[centerLbHex] || 0;
    if (!floors) { selector.classList.remove('active'); return; }
    selector.classList.add('active');
    const html = ['<span>Floor:</span>'];
    for (let i = floors - 1; i >= 0; i--) {
      // Top floor (index 0) goes at the top of the strip — matches how
      // players think of floor 1 = ground.
      html.unshift('<button class="floor-btn" data-floor="' + i + '" data-lb="' + centerLbHex + '">' +
        (i === 0 ? 'top' : i === floors - 1 ? 'bot' : (i + 1)) + '</button>');
    }
    selector.innerHTML = html.join('');
    Array.prototype.forEach.call(selector.querySelectorAll('.floor-btn'), function (btn) {
      btn.addEventListener('click', function () {
        const f = parseInt(btn.dataset.floor, 10);
        const lb = btn.dataset.lb;
        showFloor(lb, f);
        Array.prototype.forEach.call(selector.querySelectorAll('.floor-btn'), function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });
  }

  function showFloor(lbHex, floorIndex) {
    if (floorImageOverlay) { map.removeLayer(floorImageOverlay); floorImageOverlay = null; }
    const proj = MANIFEST.projects.find(function (p) { return p.slug === activeProject; });
    const projMaxZoom = (proj && proj.maxZoom) || 12;
    const url = 'projects/' + activeProject + '/tiles/floor/' + lbHex + '/' +
      projMaxZoom +
      '/' + lbBaseTileX(lbHex, projMaxZoom) + '/' + lbBaseTileY(lbHex, projMaxZoom) +
      '/' + floorIndex + '.png';
    const lbX = parseInt(lbHex.slice(2, 4), 16);
    const lbY = parseInt(lbHex.slice(4, 6), 16);
    const sw = L.latLng(lbY * LB_SIZE, lbX * LB_SIZE);
    const ne = L.latLng((lbY + 1) * LB_SIZE, (lbX + 1) * LB_SIZE);
    floorImageOverlay = L.imageOverlay(url, L.latLngBounds(sw, ne), {
      opacity: 1.0, interactive: false,
    });
    floorImageOverlay.addTo(map);
    // Floor-mode visibility: keep terrain (surface context), hide both
    // object layers (glyphs + sprites) so building roofs no longer occlude
    // the dungeon floor plan.
    if (terrainLayer) terrainLayer.setOpacity(1);
    if (objectsGlyphLayer && map.hasLayer(objectsGlyphLayer)) map.removeLayer(objectsGlyphLayer);
    if (objectLayer && map.hasLayer(objectLayer)) map.removeLayer(objectLayer);

    // Lazy-load the dungeon describer for this LB.
    loadScript('projects/' + activeProject + '/dungeons/' + lbHex + '.js').then(function () {
      const dungeon = DUNGEON[lbHex];
      if (!dungeon || !dungeon.floors) return;
      const f = dungeon.floors.find(function (x) { return x.index === floorIndex; });
      if (!f) return;
      // Inject the floor's verbal into the describe panel.
      const panel = document.getElementById('describe-panel');
      panel.innerHTML += '<div class="panel-section"><h3>Floor</h3><p>' +
        escapeHtml(f.verbal) + '</p></div>';
    }, function () { /* dungeon JS missing — fine */ });
  }

  // Why: tilesPerLbSide = 2^(zoom-8). The previous hardcoded `* 16` only
  // matched maxZoom=12; at maxZoom=8..11 the floor-overlay URL pointed at
  // a coordinate the emitter had never written to.
  function lbBaseTileX(lbHex, zoom) {
    const lbX = parseInt(lbHex.slice(2, 4), 16);
    const tilesPerLbSide = 1 << Math.max(0, zoom - 8);
    return lbX * tilesPerLbSide;
  }
  function lbBaseTileY(lbHex, zoom) {
    const lbY = parseInt(lbHex.slice(4, 6), 16);
    const tilesPerLbSide = 1 << Math.max(0, zoom - 8);
    return (255 - lbY) * tilesPerLbSide;
  }

  // ── URL deep linking ──────────────────────────────────────────────────

  function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      project: params.get('project') || null,
      z: parseInt(params.get('z'), 10) || null,
      x: parseFloat(params.get('x')),
      y: parseFloat(params.get('y')),
      floor: parseInt(params.get('floor'), 10),
    };
  }

  function restoreOrInitView(initial) {
    // URL-anchored deep link wins — restore the exact LB the user shared.
    if (!isNaN(initial.x) && !isNaN(initial.y)) {
      const cx = initial.x * LB_SIZE + LB_SIZE / 2;
      const cy = initial.y * LB_SIZE + LB_SIZE / 2;
      map.setView(L.latLng(cy, cx), initial.z || 9);
      if (!isNaN(initial.floor)) {
        // Why: parseFloat keeps decimals, but lbHex must be 2 hex digits per
        // axis. Without floor() a deep link like ?x=10.5&y=180.5 produces
        // '0xA.880B4' — invalid hex that breaks the floor lookup.
        const lbHex = '0x' +
          Math.floor(initial.x).toString(16).toUpperCase().padStart(2, '0') +
          Math.floor(initial.y).toString(16).toUpperCase().padStart(2, '0');
        setTimeout(function () { showFloor(lbHex, initial.floor); }, 50);
      }
      return;
    }
    // Why: a fresh load has no URL params. Renders typically cover a small
    // contiguous cluster (a town + neighbors), but a project may have
    // scattered LBs (e.g. a town + a far-off dungeon). Fitting to the
    // global bbox of all LBs in that case zooms out so far the user sees
    // a black void with a few tiny tiles. Instead, pick the largest
    // cluster and fit to that — the user can still navigate to outliers
    // via overlays or deep-link.
    const cluster = densestCluster(activeProjectMeta.lbList, 4);
    const lbBounds = lbListBounds(cluster.length ? cluster : activeProjectMeta.lbList);
    if (lbBounds) {
      map.fitBounds(lbBounds, { padding: [40, 40], maxZoom: initial.z || 9 });
    } else {
      map.fitBounds(L.latLngBounds(L.latLng(0, 0), L.latLng(WORLD_EXTENT, WORLD_EXTENT)));
    }
  }

  // Compute a latLng bounds covering every LB in the given list.
  function lbListBounds(lbList) {
    if (!lbList || !lbList.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    lbList.forEach(function (hex) {
      const lbX = parseInt(hex.slice(2, 4), 16);
      const lbY = parseInt(hex.slice(4, 6), 16);
      const x0 = lbX * LB_SIZE, x1 = x0 + LB_SIZE;
      const y0 = lbY * LB_SIZE, y1 = y0 + LB_SIZE;
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
    });
    return L.latLngBounds(L.latLng(minY, minX), L.latLng(maxY, maxX));
  }

  // Pick the largest connected-by-Chebyshev-distance cluster of LBs from
  // the list. Anchor: the LB with the most neighbors within `threshold`,
  // then BFS its component. Returns the cluster's LB hexes; empty list
  // when the input is empty. Used so a project with both a town and a
  // far-off dungeon doesn't make fitBounds zoom out to fit both.
  function densestCluster(lbList, threshold) {
    if (!lbList || !lbList.length) return [];
    const lbs = lbList.map(function (hex) {
      return {
        hex: hex,
        x: parseInt(hex.slice(2, 4), 16),
        y: parseInt(hex.slice(4, 6), 16),
      };
    });
    let bestIdx = 0, bestCount = -1;
    for (let i = 0; i < lbs.length; i++) {
      let count = 0;
      for (let j = 0; j < lbs.length; j++) {
        if (i === j) continue;
        if (Math.abs(lbs[i].x - lbs[j].x) <= threshold &&
            Math.abs(lbs[i].y - lbs[j].y) <= threshold) count++;
      }
      if (count > bestCount) { bestCount = count; bestIdx = i; }
    }
    const visited = new Set([bestIdx]);
    const queue = [bestIdx];
    while (queue.length) {
      const i = queue.shift();
      for (let j = 0; j < lbs.length; j++) {
        if (visited.has(j)) continue;
        if (Math.abs(lbs[i].x - lbs[j].x) <= threshold &&
            Math.abs(lbs[i].y - lbs[j].y) <= threshold) {
          visited.add(j);
          queue.push(j);
        }
      }
    }
    return Array.from(visited).map(function (i) { return lbs[i].hex; });
  }

  function onViewChanged() {
    const c = map.getCenter();
    const lbHex = lbHexFor(c);
    updateFloorSelector(lbHex);

    const params = new URLSearchParams(window.location.search);
    params.set('project', activeProject);
    params.set('z', map.getZoom());
    if (lbHex) {
      const lbX = parseInt(lbHex.slice(2, 4), 16);
      const lbY = parseInt(lbHex.slice(4, 6), 16);
      params.set('x', lbX);
      params.set('y', lbY);
    }
    history.replaceState({}, '', '?' + params.toString());
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  function lbHexFor(latLng) {
    const x = latLng.lng, y = latLng.lat;
    if (x < 0 || y < 0 || x > WORLD_EXTENT || y > WORLD_EXTENT) return null;
    const lbX = Math.floor(x / LB_SIZE);
    const lbY = Math.floor(y / LB_SIZE);
    return '0x' +
      lbX.toString(16).toUpperCase().padStart(2, '0') +
      lbY.toString(16).toUpperCase().padStart(2, '0');
  }

  function setStatus(msg) {
    const el = document.getElementById('status-line');
    if (el) el.textContent = msg;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Dynamic <script> loader. Returns a Promise that resolves when the
  // script's load event fires (i.e. its global side-effects are present).
  // Memoizes per-URL so repeated calls don't re-inject.
  function loadScript(url) {
    if (SCRIPT_PROMISES[url]) return SCRIPT_PROMISES[url];
    SCRIPT_PROMISES[url] = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed: ' + url)); };
      document.head.appendChild(s);
    });
    return SCRIPT_PROMISES[url];
  }
})();
