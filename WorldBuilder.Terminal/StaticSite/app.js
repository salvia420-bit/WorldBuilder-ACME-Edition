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

    // Live overlay hook: Phase 4+ may drop a dynamic_players.js next to the
    // dist; we silently no-op when it's absent.
    loadScript('overlays/dynamic_players.js').catch(function () { /* ignore */ });
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

  function installTileLayers(slug) {
    if (terrainLayer) { map.removeLayer(terrainLayer); terrainLayer = null; }
    if (objectsGlyphLayer) { map.removeLayer(objectsGlyphLayer); objectsGlyphLayer = null; }
    if (objectLayer) { map.removeLayer(objectLayer); objectLayer = null; }
    if (exteriorLayer) { map.removeLayer(exteriorLayer); exteriorLayer = null; }

    const proj = MANIFEST.projects.find(function (p) { return p.slug === slug; });
    const minZ = (proj && proj.minZoom) || 3;
    const maxZ = (proj && proj.maxZoom) || 12;
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
    const overlayNames = ['towns', 'pois', 'spawns', 'housing', 'grid', 'diagnostics'];
    const layers = {};
    overlayNames.forEach(function (name) {
      const path = 'projects/' + slug + '/overlays/' + name + '.js';
      loadScript(path).then(function () {
        const data = OVERLAY_DATA[name];
        if (!data) return;
        const layer = renderOverlay(name, data);
        if (layer) {
          layers[name] = layer;
          // Refresh the layer-control to pick up newly-loaded layers. The
          // simplest way: rebuild the control each time. Cheap with <10
          // layers.
          rebuildLayerControl(layers);
        }
      }, function () { /* missing overlay file → silent */ });
    });
  }

  let layerControl = null;
  function rebuildLayerControl(layers) {
    if (layerControl) map.removeControl(layerControl);
    layerControl = L.control.layers({}, layers, { collapsed: false, position: 'topright' });
    layerControl.addTo(map);
  }

  function renderOverlay(name, data) {
    // Each overlay carries a different shape; render conservatively.
    // Towns: list of { name, x, y, ... }. Grid: a single config object.
    const group = L.layerGroup();
    if (name === 'grid') {
      // Light landblock-grid lines every 192 wu.
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
    // Generic markerable overlay: try to find an array of records each
    // with x/y or position fields. Fail silently otherwise.
    const records = Array.isArray(data) ? data : (data.entries || data.items);
    if (Array.isArray(records)) {
      records.forEach(function (rec) {
        const x = rec.x != null ? rec.x : (rec.position ? rec.position.x : null);
        const y = rec.y != null ? rec.y : (rec.position ? rec.position.y : null);
        if (x == null || y == null) return;
        const m = L.circleMarker([y, x], {
          radius: 4, color: overlayColor(name), fillOpacity: 0.85, weight: 1,
        });
        const title = rec.name || rec.title || rec.label;
        if (title) m.bindTooltip(title, { sticky: true });
        group.addLayer(m);
      });
    }
    return group;
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
  }

  function renderDescribePanelFallback(lbHex) {
    document.getElementById('describe-panel').innerHTML =
      '<div class="panel-section"><h3>Landblock</h3>' +
      '<p>' + lbHex + ' (no description available)</p></div>';
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
    const url = 'projects/' + activeProject + '/tiles/floor/' + lbHex + '/' +
      MANIFEST.projects.find(function (p) { return p.slug === activeProject; }).maxZoom +
      '/' + lbBaseTileX(lbHex) + '/' + lbBaseTileY(lbHex) + '/' + floorIndex + '.png';
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

  function lbBaseTileX(lbHex) {
    const lbX = parseInt(lbHex.slice(2, 4), 16);
    return lbX * 16;  // assumes maxZoom=12; harmless for lower since path uses real maxZoom.
  }
  function lbBaseTileY(lbHex) {
    const lbY = parseInt(lbHex.slice(4, 6), 16);
    return (255 - lbY) * 16;
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
        const lbHex = '0x' +
          initial.x.toString(16).toUpperCase().padStart(2, '0') +
          initial.y.toString(16).toUpperCase().padStart(2, '0');
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
