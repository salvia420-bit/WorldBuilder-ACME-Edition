// app/server_picker.js — the login form's server picker (community
// serverslist fetch + cache, picker <-> host/port field sync, server meta
// card). Extracted verbatim from index.html's inline script (2026-10-05);
// index.html calls initServerPicker() at the same point the code used to run,
// passing the DOM/closure dependencies explicitly.

import { escapeHtml } from "./dom_utils.js";

export function initServerPicker(D) {
  const { loginForm } = D;
  // Server picker — fed by the acresources/serverslist
  // community list. Loads asynchronously in the background; while
  // it's pending, the manual host/port fields stay editable so
  // local-dev login still works without waiting.
  const SERVERSLIST_URL =
    "https://raw.githubusercontent.com/acresources/serverslist/master/Servers.xml";
  const SERVERSLIST_CACHE_KEY = "holtburger_serverslist_v1";
  const SERVERSLIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const serverPicker = document.getElementById("server-picker");
  const serverHostInput = loginForm.querySelector('input[name="server_host"]');
  const serverPortInput = loginForm.querySelector('input[name="server_port"]');
  const serverMeta = document.getElementById("server-meta");
  let knownServers = []; // [{id, name, description, host, port, type, status, website, discord}]
  let suppressPickerReset = false;

  function parseServersXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error(`XML parse error: ${err.textContent ?? ""}`);
    const items = Array.from(doc.querySelectorAll("ServerItem"));
    const text = (el, sel) =>
      (el.querySelector(sel)?.textContent ?? "").trim();
    return items
      .map((el) => ({
        id: text(el, "id"),
        name: text(el, "name"),
        description: text(el, "description"),
        emu: text(el, "emu"),
        host: text(el, "server_host"),
        port: Number(text(el, "server_port") || "0") || 9000,
        type: text(el, "type"),
        status: text(el, "status"),
        website: text(el, "website_url"),
        discord: text(el, "discord_url"),
      }))
      .filter((s) => s.emu === "ACE" && s.host && s.name);
  }

  function populatePicker(servers) {
    knownServers = servers;
    serverPicker.innerHTML = "";

    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "Custom (use fields below)";
    serverPicker.appendChild(customOpt);

    const groups = new Map();
    for (const s of servers) {
      const key = s.status || "Unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const order = ["Stable", "Development", "Experimental", "Unknown"];
    for (const key of order) {
      const list = groups.get(key);
      if (!list?.length) continue;
      const og = document.createElement("optgroup");
      og.label = key;
      for (const s of list.sort((a, b) => a.name.localeCompare(b.name))) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name}  —  ${s.host}:${s.port}`;
        opt.dataset.host = s.host;
        opt.dataset.port = String(s.port);
        og.appendChild(opt);
      }
      serverPicker.appendChild(og);
    }
    // If the host/port fields already match a known server, select it.
    syncPickerFromFields();
  }

  function syncPickerFromFields() {
    const host = serverHostInput.value.trim();
    const port = Number(serverPortInput.value || 0);
    const match = knownServers.find(
      (s) => s.host === host && s.port === port,
    );
    suppressPickerReset = true;
    serverPicker.value = match ? match.id : "__custom__";
    suppressPickerReset = false;
    renderServerMeta(match);
  }

  function renderServerMeta(s) {
    if (!s) {
      serverMeta.hidden = true;
      serverMeta.innerHTML = "";
      return;
    }
    const parts = [];
    if (s.description) parts.push(escapeHtml(s.description));
    const links = [];
    // `escapeHtml` stops an attribute break-out but NOT a dangerous SCHEME:
    // `href="javascript:…"` survives entity-escaping untouched and runs on
    // click. These two URLs come straight out of the community
    // `acresources/serverslist` XML fetched over the network (SERVERSLIST_URL
    // above) and are cached in localStorage, so one bad/compromised row is a
    // one-click script execution that persists across reloads. Allow only
    // http/https absolute URLs; anything else renders as inert escaped text.
    const safeHref = (u) => {
      try {
        const parsed = new URL(String(u), window.location.href);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
          ? parsed.href
          : null;
      } catch (_) { return null; }
    };
    const linkOrText = (u, label) => {
      const href = safeHref(u);
      return href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`
        : `<span class="hint">${label}: ${escapeHtml(u)}</span>`;
    };
    if (s.website) links.push(linkOrText(s.website, "website"));
    if (s.discord) links.push(linkOrText(s.discord, "discord"));
    if (links.length) parts.push(links.join(" · "));
    if (s.type || s.status) {
      const tags = [s.type, s.status].filter(Boolean).join(" · ");
      parts.push(`<em>${escapeHtml(tags)}</em>`);
    }
    serverMeta.innerHTML = parts.join("<br>");
    serverMeta.hidden = parts.length === 0;
  }

  serverPicker.addEventListener("change", () => {
    if (suppressPickerReset) return;
    const id = serverPicker.value;
    if (id === "__custom__" || id === "") {
      renderServerMeta(null);
      return;
    }
    const s = knownServers.find((x) => x.id === id);
    if (!s) return;
    serverHostInput.value = s.host;
    serverPortInput.value = String(s.port);
    renderServerMeta(s);
  });
  serverHostInput.addEventListener("input", syncPickerFromFields);
  serverPortInput.addEventListener("input", syncPickerFromFields);

  (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(SERVERSLIST_CACHE_KEY) ?? "null");
      if (cached?.servers && Array.isArray(cached.servers)) {
        populatePicker(cached.servers);
      }
    } catch {}
    try {
      const cached = JSON.parse(localStorage.getItem(SERVERSLIST_CACHE_KEY) ?? "null");
      const fresh = cached?.fetchedAt && Date.now() - cached.fetchedAt < SERVERSLIST_CACHE_TTL_MS;
      if (fresh) return; // cache still warm; skip the network round-trip
      const resp = await fetch(SERVERSLIST_URL, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const servers = parseServersXml(xml);
      if (servers.length) {
        populatePicker(servers);
        try {
          localStorage.setItem(
            SERVERSLIST_CACHE_KEY,
            JSON.stringify({ fetchedAt: Date.now(), servers }),
          );
        } catch {}
      }
    } catch (e) {
      console.warn("[servers] fetch failed; staying with cache or manual entry:", e);
      if (!knownServers.length) {
        serverPicker.innerHTML =
          '<option value="__custom__">Custom (use fields below)</option>';
      }
    }
  })();
}
