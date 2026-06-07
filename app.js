/* ============================================================
   XENON • Lecteur IPTV Web
   - Profils (Xtream / M3U) stockés en localStorage
   - proxy.php contourne CORS / contenu mixte
   - LIVE : lecteur embarqué + rail de chaînes (zapping sans fermer)
            lecture mpegts.js (flux .ts continu) en priorité, repli HLS
   - VOD / SÉRIES : grille + overlay lecteur
   ============================================================ */

(function () {
  "use strict";

  const LS_KEY = "xenon_profiles";
  const LS_LAST = "xenon_last";
  const LS_FAV = "xenon_favorites";   // favoris LIVE par profil
  const FAV_CAT = "__fav__";          // identifiant de la pseudo-catégorie Favoris

  // État
  let profile = null;            // { name, host, user, pass }
  let section = "live";          // live | vod | series
  let categories = [];
  let activeCat = null;
  let items = [];                // contenu de la catégorie courante
  let searchTerm = "";

  // Rendu incrémental de la grille (évite de créer des milliers de cartes d'un coup)
  let gridIO = null;             // IntersectionObserver pour le chargement progressif
  let gridData = [];             // liste en cours d'affichage
  let gridShown = 0;             // nombre de cartes déjà rendues
  const GRID_BATCH = 60;         // cartes ajoutées par lot

  // Lecteur LIVE (embarqué)
  let liveHls = null;
  let liveMpegts = null;
  let liveMode = "hls";          // mpegts | hls
  let currentLive = null;        // { id, name }

  // Lecteur VOD (overlay)
  let vodHls = null;

  // ---------- Helpers ----------
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  function proxied(url) { return "proxy.php?url=" + encodeURIComponent(url); }

  // Icônes étoile (SVG) — pleine (favori actif) et contour (non favori)
  const STAR_FILLED_SVG = '<svg class="star-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.56l-5.91 3.1 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"/></svg>';
  const STAR_OUTLINE_SVG = '<svg class="star-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.56l-5.91 3.1 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"/></svg>';

  // ---------- localStorage ----------
  function getProfiles() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; }
  }
  function saveProfiles(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  function upsertProfile(p) {
    const list = getProfiles();
    const key = p.host + "|" + p.user;
    const i = list.findIndex((x) => (x.host + "|" + x.user) === key);
    if (i >= 0) list[i] = p; else list.push(p);
    saveProfiles(list);
    localStorage.setItem(LS_LAST, key);
  }
  function removeProfile(key) {
    saveProfiles(getProfiles().filter((x) => (x.host + "|" + x.user) !== key));
    renderSavedProfiles();
  }

  // ---------- Favoris (LIVE) ----------
  // Stockés par profil : { "host|user": [ {stream_id, name, stream_icon}, ... ] }
  function profileKey() { return profile ? (profile.host + "|" + profile.user) : ""; }
  function getFavStore() {
    try { return JSON.parse(localStorage.getItem(LS_FAV)) || {}; } catch (e) { return {}; }
  }
  function saveFavStore(store) { localStorage.setItem(LS_FAV, JSON.stringify(store)); }
  function getFavorites() {
    const store = getFavStore();
    return Array.isArray(store[profileKey()]) ? store[profileKey()] : [];
  }
  function isFav(id) { return getFavorites().some((f) => f.stream_id == id); }
  function toggleFav(it) {
    const store = getFavStore();
    const key = profileKey();
    const list = Array.isArray(store[key]) ? store[key] : [];
    const i = list.findIndex((f) => f.stream_id == it.stream_id);
    if (i >= 0) {
      list.splice(i, 1);
    } else {
      list.push({ stream_id: it.stream_id, name: it.name || "Chaîne", stream_icon: it.stream_icon || "" });
    }
    store[key] = list;
    saveFavStore(store);
    return i < 0; // true si ajouté
  }

  // ---------- API Xtream ----------
  function apiBase() {
    return profile.host + "/player_api.php?username=" +
      encodeURIComponent(profile.user) + "&password=" + encodeURIComponent(profile.pass);
  }
  async function api(action, extra) {
    const url = apiBase() + "&action=" + action + (extra || "");
    const res = await fetch(proxied(url));
    const txt = await res.text();
    try { return JSON.parse(txt); } catch (e) { throw new Error("Réponse invalide du serveur"); }
  }
  async function apiAuth() {
    const res = await fetch(proxied(apiBase()));
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch (e) { throw new Error("Serveur injoignable ou identifiants invalides."); }
    if (!data || !data.user_info || data.user_info.auth !== 1) {
      throw new Error("Authentification refusée. Vérifie tes identifiants / ton serveur.");
    }
    return data;
  }

  // ---------- Connexion ----------
  function normalizeHost(h) {
    h = (h || "").trim();
    if (!h) return "";
    if (!/^https?:\/\//i.test(h)) h = "http://" + h;
    return h.replace(/\/+$/, "");
  }
  function parseM3uUrl(raw) {
    raw = (raw || "").trim();
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    const user = u.searchParams.get("username");
    const pass = u.searchParams.get("password");
    if (!user || !pass) return null;
    return { host: u.origin, user, pass };
  }
  async function connect(p, save) {
    profile = p;
    showLoginError("");
    setLoginLoading(true);
    try {
      await apiAuth();
      if (save) upsertProfile(p);
      enterApp();
    } catch (err) {
      profile = null;
      showLoginError(err.message || "Connexion impossible.");
    } finally {
      setLoginLoading(false);
    }
  }
  function setLoginLoading(on) {
    document.querySelectorAll(".btn-primary").forEach((b) => {
      b.disabled = on; b.textContent = on ? "Connexion..." : "Se connecter";
    });
  }
  function showLoginError(msg) {
    const box = $("#loginError");
    if (!msg) { box.classList.add("hidden"); return; }
    box.textContent = msg; box.classList.remove("hidden");
  }

  // ---------- Profils enregistrés ----------
  function renderSavedProfiles() {
    const wrap = $("#savedProfiles");
    wrap.innerHTML = "";
    const list = getProfiles();
    if (!list.length) return;
    const title = el("div");
    title.style.cssText = "color:var(--muted);font-size:12px;margin:6px 0;font-weight:700;text-transform:uppercase;letter-spacing:1px";
    title.textContent = "Profils enregistrés";
    wrap.appendChild(title);

    list.forEach((p) => {
      const chip = el("div", "profile-chip");
      const go = el("button", "pc-go");
      go.innerHTML =
        '<div class="pc-info"><span class="pc-dot"></span><div style="min-width:0">' +
        '<div class="pc-name"></div><div class="pc-host"></div></div></div>';
      go.querySelector(".pc-name").textContent = p.name || p.user;
      go.querySelector(".pc-host").textContent = p.host;
      go.onclick = () => connect(p, false);

      const del = el("button");
      del.textContent = "✕";
      del.title = "Supprimer";
      del.onclick = (e) => { e.stopPropagation(); removeProfile(p.host + "|" + p.user); };

      chip.appendChild(go);
      chip.appendChild(del);
      wrap.appendChild(chip);
    });
  }

  // ---------- Entrée / sortie app ----------
  function enterApp() {
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#profileInitial").textContent = (profile.name || profile.user || "?").charAt(0).toUpperCase();
    section = "live";
    setActiveTab();
    syncLiveFavBtn();
    loadSection();
  }
  function logout() {
    destroyLive();
    destroyVod();
    profile = null;
    $("#app").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
    renderSavedProfiles();
  }

  // ---------- Sidebar (mobile) ----------
  function isMobile() { return window.matchMedia("(max-width:820px)").matches; }
  function syncTopbarHeight() {
    const tb = document.querySelector(".topbar");
    if (tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }
  function openSidebar() {
    syncTopbarHeight();
    $("#sidebar").classList.add("open");
    $("#sidebarBackdrop").classList.remove("hidden");
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#sidebarBackdrop").classList.add("hidden");
  }
  function toggleSidebar() {
    $("#sidebar").classList.contains("open") ? closeSidebar() : openSidebar();
  }

  // ---------- Sections ----------
  function setActiveTab() {
    document.querySelectorAll(".nav-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.section === section));
  }
  function showGridLoader(on) { $("#loader").classList.toggle("hidden", !on); }
  function showGridEmpty(on) { $("#emptyState").classList.toggle("hidden", !on); }
  function showRailLoader(on) { $("#railLoader").classList.toggle("hidden", !on); }
  function showRailEmpty(on) { $("#railEmpty").classList.toggle("hidden", !on); }

  async function loadSection() {
    activeCat = null;
    items = [];
    searchTerm = "";
    $("#searchInput").value = "";

    const isLive = section === "live";
    $("#liveView").classList.toggle("hidden", !isLive);
    $("#vodView").classList.toggle("hidden", isLive);

    $("#categoryList").innerHTML = "";
    $("#grid").innerHTML = "";
    $("#channelList").innerHTML = "";
    showGridEmpty(false); showRailEmpty(false);

    if (isLive) { showRailLoader(true); $("#railTitle").textContent = "Chaînes"; }
    else { showGridLoader(true); $("#contentHeader").textContent = section === "vod" ? "Films" : "Séries"; }

    const catAction = { live: "get_live_categories", vod: "get_vod_categories", series: "get_series_categories" }[section];
    try {
      const cats = await api(catAction);
      categories = Array.isArray(cats) ? cats : [];
      renderCategories();
      // En LIVE, on ouvre la catégorie "Favoris" par défaut
      if (isLive) selectCategory(FAV_CAT);
      else if (categories.length) selectCategory(categories[0].category_id);
      else { showRailLoader(false); showGridLoader(false); showGridEmpty(true); }
    } catch (e) {
      showRailLoader(false); showGridLoader(false);
      isLive ? showRailEmpty(true) : showGridEmpty(true);
    }
  }

  function renderCategories() {
    const list = $("#categoryList");
    list.innerHTML = "";

    // Pseudo-catégorie "Favoris" tout en haut (LIVE uniquement)
    if (section === "live") {
      const fav = el("button", "cat-item cat-fav");
      fav.dataset.id = FAV_CAT;
      fav.title = "Favoris";
      const star = el("span", "cat-star");
      star.innerHTML = STAR_FILLED_SVG;
      const lbl = el("span"); lbl.textContent = "Favoris";
      fav.appendChild(star); fav.appendChild(lbl);
      fav.onclick = () => selectCategory(FAV_CAT);
      list.appendChild(fav);
    }

    categories.forEach((c) => {
      const b = el("button", "cat-item");
      b.textContent = c.category_name;
      b.title = c.category_name;
      b.dataset.id = c.category_id;
      b.onclick = () => selectCategory(c.category_id);
      list.appendChild(b);
    });
  }

  async function selectCategory(catId) {
    activeCat = catId;
    document.querySelectorAll(".cat-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.id == catId));
    if (isMobile()) closeSidebar();

    const isLive = section === "live";
    if (isLive) { $("#channelList").innerHTML = ""; showRailEmpty(false); showRailLoader(true); }
    else { $("#grid").innerHTML = ""; showGridEmpty(false); showGridLoader(true); }

    // Catégorie spéciale "Favoris" : on lit directement le localStorage
    if (isLive && catId === FAV_CAT) {
      items = getFavorites();
      showRailLoader(false);
      renderChannelRail();
      return;
    }

    const action = { live: "get_live_streams", vod: "get_vod_streams", series: "get_series" }[section];
    try {
      const data = await api(action, "&category_id=" + encodeURIComponent(catId));
      items = Array.isArray(data) ? data : [];
    } catch (e) { items = []; }

    if (isLive) { showRailLoader(false); renderChannelRail(); }
    else { showGridLoader(false); renderGrid(); }
  }

  function filtered() {
    if (!searchTerm) return items;
    const t = searchTerm.toLowerCase();
    return items.filter((it) => (it.name || it.title || "").toLowerCase().includes(t));
  }

  // ---------- Rail des chaînes (LIVE) ----------
  function renderChannelRail() {
    const list = $("#channelList");
    list.innerHTML = "";
    const data = filtered();
    if (!data.length) { showRailEmpty(true); return; }
    showRailEmpty(false);

    const frag = document.createDocumentFragment();
    data.forEach((it) => {
      const row = el("div", "ch-item");
      row.dataset.id = it.stream_id;
      if (currentLive && currentLive.id == it.stream_id) row.classList.add("active");

      const logo = el("div", "ch-logo");
      const name = it.name || "Chaîne";
      if (it.stream_icon) {
        const img = el("img"); img.loading = "lazy"; img.alt = ""; img.src = it.stream_icon;
        img.onerror = () => { logo.innerHTML = ""; const ph = el("div", "ph"); ph.textContent = name.charAt(0).toUpperCase(); logo.appendChild(ph); };
        logo.appendChild(img);
      } else { const ph = el("div", "ph"); ph.textContent = name.charAt(0).toUpperCase(); logo.appendChild(ph); }

      const text = el("div", "ch-text");
      const nm = el("div", "ch-name"); nm.textContent = name; nm.title = name;
      const sub = el("div", "ch-sub"); sub.textContent = "● LIVE";
      text.appendChild(nm); text.appendChild(sub);

      // Étoile jaune (ajout / retrait des favoris)
      const favBtn = el("button", "fav-btn");
      const on = isFav(it.stream_id);
      if (on) favBtn.classList.add("on");
      favBtn.innerHTML = on ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
      favBtn.title = on ? "Retirer des favoris" : "Ajouter aux favoris";
      favBtn.onclick = (e) => {
        e.stopPropagation();
        const added = toggleFav(it);
        favBtn.classList.toggle("on", added);
        favBtn.innerHTML = added ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
        favBtn.title = added ? "Retirer des favoris" : "Ajouter aux favoris";
        syncLiveFavBtn();
        // Si on est dans la vue Favoris, retirer = enlever la ligne immédiatement
        if (activeCat === FAV_CAT && !added) {
          row.remove();
          items = getFavorites();
          if (!items.length) showRailEmpty(true);
        }
      };

      row.appendChild(logo); row.appendChild(text); row.appendChild(favBtn);
      row.onclick = () => playLive(it.stream_id, name, it);
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  function markActiveChannel(id) {
    document.querySelectorAll(".ch-item").forEach((b) =>
      b.classList.toggle("active", b.dataset.id == id));
  }

  // ---------- Grille (VOD / SÉRIES) ----------
  function renderGrid() {
    const grid = $("#grid");
    // Réinitialise l'observateur précédent et le contenu
    if (gridIO) { gridIO.disconnect(); gridIO = null; }
    grid.innerHTML = "";
    gridData = filtered();
    gridShown = 0;
    if (!gridData.length) { showGridEmpty(true); return; }
    showGridEmpty(false);

    // Premier lot
    appendGridBatch();

    // Sentinelle de fin de liste : charge le lot suivant à l'approche du bas
    const sentinel = el("div", "grid-sentinel");
    grid.appendChild(sentinel);
    gridIO = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        appendGridBatch();
        // Replace la sentinelle à la fin pour continuer le chargement
        if (gridShown < gridData.length) grid.appendChild(sentinel);
        else { gridIO.disconnect(); gridIO = null; sentinel.remove(); }
      }
    }, { root: grid, rootMargin: "600px 0px" });
    gridIO.observe(sentinel);
  }

  function appendGridBatch() {
    const grid = $("#grid");
    const end = Math.min(gridShown + GRID_BATCH, gridData.length);
    const frag = document.createDocumentFragment();
    for (let i = gridShown; i < end; i++) frag.appendChild(buildCard(gridData[i]));
    grid.appendChild(frag);
    gridShown = end;
  }
  function buildCard(it) {
    const card = el("div", "card");
    const thumb = el("div", "card-thumb");
    const logo = it.stream_icon || it.cover || it.cover_big || "";
    const name = it.name || it.title || "Sans titre";
    if (logo) {
      const img = el("img"); img.loading = "lazy"; img.alt = name; img.src = logo;
      img.onerror = () => { thumb.innerHTML = ""; const ph = el("div", "ph"); ph.textContent = name.charAt(0).toUpperCase(); thumb.appendChild(ph); };
      thumb.appendChild(img);
    } else { const ph = el("div", "ph"); ph.textContent = name.charAt(0).toUpperCase(); thumb.appendChild(ph); }
    const label = el("div", "card-name"); label.textContent = name; label.title = name;
    card.appendChild(thumb); card.appendChild(label);
    card.onclick = () => (section === "vod" ? openMovie(it) : openSeries(it));
    return card;
  }

  // ---------- URLs de flux ----------
  function liveUrl(id, ext) {
    return profile.host + "/live/" + encodeURIComponent(profile.user) + "/" +
      encodeURIComponent(profile.pass) + "/" + id + "." + ext;
  }
  function movieUrl(id, ext) {
    return profile.host + "/movie/" + encodeURIComponent(profile.user) + "/" +
      encodeURIComponent(profile.pass) + "/" + id + "." + (ext || "mp4");
  }
  function seriesUrl(id, ext) {
    return profile.host + "/series/" + encodeURIComponent(profile.user) + "/" +
      encodeURIComponent(profile.pass) + "/" + id + "." + (ext || "mp4");
  }

  // ---------- Statut lecteur LIVE ----------
  function liveStatus(msg, isErr) {
    const s = $("#liveStatus");
    if (!msg) { s.classList.add("hidden"); return; }
    s.textContent = msg;
    s.classList.toggle("err", !!isErr);
    s.classList.remove("hidden");
  }
  function updateLiveModeBtn() {
    $("#liveModeBtn").textContent = "Moteur : " + (liveMode === "hls" ? "HLS" : "MPEGTS");
  }

  function destroyLive() {
    const v = $("#liveVideo");
    if (liveHls) { try { liveHls.destroy(); } catch (e) {} liveHls = null; }
    if (liveMpegts) { try { liveMpegts.destroy(); } catch (e) {} liveMpegts = null; }
    if (v) { try { v.onratechange = null; v.playbackRate = 1; v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} }
  }

  // Lecture LIVE : HLS prioritaire (par défaut), repli mpegts (.ts continu)
  function playLive(id, name, it) {
    currentLive = { id, name, item: it || { stream_id: id, name: name } };
    $("#nowPlaying").textContent = name;
    markActiveChannel(id);
    syncLiveFavBtn();
    startLiveHls(true);
  }

  // Synchronise l'état du bouton "Ajouter aux favoris" de la barre du lecteur
  function syncLiveFavBtn() {
    const btn = $("#liveFav");
    if (!btn) return;
    if (!currentLive) {
      btn.classList.remove("fav-on");
      btn.textContent = "☆ Ajouter aux favoris";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const on = isFav(currentLive.id);
    btn.classList.toggle("fav-on", on);
    btn.textContent = on ? "★ Retirer des favoris" : "☆ Ajouter aux favoris";
  }

  function toggleCurrentLiveFav() {
    if (!currentLive) return;
    const added = toggleFav(currentLive.item);
    syncLiveFavBtn();
    // Met à jour l'étoile de la ligne correspondante dans le rail
    const row = document.querySelector('.ch-item[data-id="' + currentLive.id + '"]');
    if (row) {
      const fb = row.querySelector(".fav-btn");
      if (fb) {
        fb.classList.toggle("on", added);
        fb.innerHTML = added ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
      }
    }
    // Si la vue Favoris est ouverte, rafraîchir la liste
    if (activeCat === FAV_CAT) selectCategory(FAV_CAT);
  }

  function startLiveMpegts(allowFallback) {
    destroyLive();
    liveMode = "mpegts";
    updateLiveModeBtn();
    const video = $("#liveVideo");
    liveStatus("Connexion au direct...");

    if (window.mpegts && mpegts.isSupported()) {
      liveMpegts = mpegts.createPlayer(
        { type: "mpegts", isLive: true, url: proxied(liveUrl(currentLive.id, "ts")) },
        {
          // Buffer stable : on NE chasse PAS la latence (sinon lecture en accéléré + freeze)
          enableStashBuffer: true,
          stashInitialSize: 1024 * 384,        // ~384 Ko de pré-buffer avant lecture
          liveBufferLatencyChasing: false,     // <- clé : empêche l'accélération x10
          liveBufferLatencyChasingOnPaused: false,
          lazyLoad: false,                     // ne pas couper le flux quand le buffer est plein
          autoCleanupSourceBuffer: true,       // évite la saturation mémoire sur le long terme
          autoCleanupMaxBackwardDuration: 30,
          autoCleanupMinBackwardDuration: 15
        }
      );
      liveMpegts.attachMediaElement(video);
      liveMpegts.on(mpegts.Events.ERROR, () => {
        if (allowFallback) startLiveHls(false);
        else liveStatus("Flux indisponible. Essaie une autre chaîne.", true);
      });
      liveMpegts.load();
      liveMpegts.play().catch(() => {});
      // Sécurité : si le navigateur a forcé une vitesse > 1, on la remet à 1
      video.addEventListener("playing", () => { video.playbackRate = 1; liveStatus(""); }, { once: true });
      video.onratechange = () => { if (video.playbackRate !== 1) video.playbackRate = 1; };
    } else if (allowFallback) {
      startLiveHls(false);
    } else {
      liveStatus("Lecture non supportée par ce navigateur.", true);
    }
  }

  function startLiveHls(allowFallback) {
    destroyLive();
    liveMode = "hls";
    updateLiveModeBtn();
    const video = $("#liveVideo");
    const url = proxied(liveUrl(currentLive.id, "m3u8"));
    liveStatus("Connexion au direct (HLS)...");

    if (window.Hls && Hls.isSupported()) {
      liveHls = new Hls({ lowLatencyMode: false, enableWorker: true, liveDurationInfinity: true, fragLoadingMaxRetry: 6 });
      liveHls.loadSource(url);
      liveHls.attachMedia(video);
      liveHls.on(Hls.Events.MANIFEST_PARSED, () => { liveStatus(""); video.play().catch(() => {}); });
      liveHls.on(Hls.Events.ERROR, (evt, data) => {
        if (data && data.fatal) {
          if (allowFallback) startLiveMpegts(false);
          else liveStatus("Flux indisponible. Essaie une autre chaîne.", true);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url; video.play().catch(() => {}); liveStatus("");
    } else if (allowFallback) {
      startLiveMpegts(false);
    } else {
      liveStatus("HLS non supporté par ce navigateur.", true);
    }
  }

  function toggleLiveMode() {
    if (!currentLive) return;
    if (liveMode === "mpegts") startLiveHls(false);
    else startLiveMpegts(false);
  }
  function reloadLive() {
    if (!currentLive) return;
    if (liveMode === "mpegts") startLiveMpegts(true);
    else startLiveHls(true);
  }
  function liveFullscreen() {
    const v = $("#liveVideo");
    if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  }

  // ---------- Lecteur VOD (overlay) ----------
  function openVodPlayer(title) {
    $("#playerTitle").textContent = title || "Lecture";
    $("#playerOverlay").classList.remove("hidden");
  }
  function vodStatus(msg, isErr) {
    const s = $("#vodStatus");
    if (!msg) { s.classList.add("hidden"); return; }
    s.textContent = msg; s.classList.toggle("err", !!isErr); s.classList.remove("hidden");
  }
  function destroyVod() {
    const v = $("#vodVideo");
    if (vodHls) { try { vodHls.destroy(); } catch (e) {} vodHls = null; }
    if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} }
  }
  function closeVodPlayer() {
    destroyVod();
    $("#playerOverlay").classList.add("hidden");
    vodStatus("");
  }
  function playVod(url, title) {
    openVodPlayer(title);
    destroyVod();
    const video = $("#vodVideo");
    vodStatus("Chargement...");
    video.src = url;
    video.play().then(() => vodStatus("")).catch(() => {});
    video.addEventListener("playing", () => vodStatus(""), { once: true });
    video.addEventListener("error", () => {
      vodStatus("Format non lisible par le navigateur (essaie un autre titre, ex. MP4).", true);
    }, { once: true });
  }

  // ---------- Détail FILM ----------
  async function openMovie(it) {
    const overlay = $("#detailOverlay");
    const box = $("#detailContent");
    overlay.classList.remove("hidden");
    box.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

    let info = {};
    try {
      const data = await api("get_vod_info", "&vod_id=" + encodeURIComponent(it.stream_id));
      info = data && data.info ? data.info : {};
    } catch (e) {}

    const ext = it.container_extension || info.container_extension || "mp4";
    const poster = info.movie_image || it.stream_icon || it.cover || "";
    const name = it.name || info.name || "Film";

    box.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-poster">' + (poster ? '<img alt="" src="' + poster + '">' : '') + '</div>' +
        '<div class="detail-info">' +
          '<h2></h2><div class="detail-meta"></div><div class="detail-plot"></div>' +
          '<button class="btn-play">▶ Lire le film</button>' +
        '</div></div>';
    box.querySelector("h2").textContent = name;
    box.querySelector(".detail-meta").textContent =
      [info.genre, info.releasedate, info.duration, info.rating ? "★ " + info.rating : ""].filter(Boolean).join("  •  ");
    box.querySelector(".detail-plot").textContent = info.plot || info.description || "";
    box.querySelector(".btn-play").onclick = () => { closeDetail(); playVod(proxied(movieUrl(it.stream_id, ext)), name); };
  }

  // ---------- Détail SÉRIE ----------
  async function openSeries(it) {
    const overlay = $("#detailOverlay");
    const box = $("#detailContent");
    overlay.classList.remove("hidden");
    box.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

    let data = {};
    try { data = await api("get_series_info", "&series_id=" + encodeURIComponent(it.series_id)); } catch (e) {}

    const info = (data && data.info) ? data.info : {};
    const episodes = (data && data.episodes) ? data.episodes : {};
    const poster = info.cover || it.cover || "";
    const name = info.name || it.name || "Série";

    box.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-poster">' + (poster ? '<img alt="" src="' + poster + '">' : '') + '</div>' +
        '<div class="detail-info"><h2></h2><div class="detail-meta"></div><div class="detail-plot"></div></div>' +
      '</div><div class="seasons" id="seasons"></div>';
    box.querySelector("h2").textContent = name;
    box.querySelector(".detail-meta").textContent =
      [info.genre, info.releaseDate, info.rating ? "★ " + info.rating : ""].filter(Boolean).join("  •  ");
    box.querySelector(".detail-plot").textContent = info.plot || "";

    const seasonsWrap = box.querySelector("#seasons");
    const seasonKeys = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
    if (!seasonKeys.length) { seasonsWrap.innerHTML = '<div style="color:var(--muted)">Aucun épisode disponible.</div>'; return; }
    seasonKeys.forEach((sk) => {
      const block = el("div", "season-block");
      const h3 = el("h3"); h3.textContent = "Saison " + sk;
      const epList = el("div", "ep-list");
      (episodes[sk] || []).forEach((ep) => {
        const row = el("div", "ep-item");
        const num = el("span", "ep-num"); num.textContent = "E" + (ep.episode_num || "?");
        const nm = el("span", "ep-name"); nm.textContent = ep.title || ("Épisode " + ep.episode_num);
        row.appendChild(num); row.appendChild(nm);
        const ext = ep.container_extension || (ep.info && ep.info.container_extension) || "mp4";
        row.onclick = () => { closeDetail(); playVod(proxied(seriesUrl(ep.id, ext)), name + " — " + nm.textContent); };
        epList.appendChild(row);
      });
      block.appendChild(h3); block.appendChild(epList);
      seasonsWrap.appendChild(block);
    });
  }
  function closeDetail() { $("#detailOverlay").classList.add("hidden"); }

  // ---------- Événements ----------
  function bindEvents() {
    document.querySelectorAll(".tab-login").forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll(".tab-login").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const mode = tab.dataset.mode;
        $("#xtreamForm").classList.toggle("hidden", mode !== "xtream");
        $("#m3uForm").classList.toggle("hidden", mode !== "m3u");
        showLoginError("");
      };
    });

    $("#xtreamForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const host = normalizeHost($("#x_host").value);
      const user = $("#x_user").value.trim();
      const pass = $("#x_pass").value.trim();
      const name = $("#x_name").value.trim() || user;
      if (!host || !user || !pass) { showLoginError("Remplis l'hôte, l'utilisateur et le mot de passe."); return; }
      connect({ name, host, user, pass }, true);
    });

    $("#m3uForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const parsed = parseM3uUrl($("#m_url").value);
      if (!parsed) { showLoginError("Lien M3U invalide (il doit contenir username= et password=)."); return; }
      const name = $("#m_name").value.trim() || parsed.user;
      connect({ name, host: parsed.host, user: parsed.user, pass: parsed.pass }, true);
    });

    document.querySelectorAll(".nav-tab").forEach((tab) => {
      tab.onclick = () => {
        if (section === tab.dataset.section) return;
        section = tab.dataset.section;
        setActiveTab();
        loadSection();
      };
    });

    let t;
    $("#searchInput").addEventListener("input", (e) => {
      searchTerm = e.target.value.trim();
      clearTimeout(t);
      t = setTimeout(() => { section === "live" ? renderChannelRail() : renderGrid(); }, 180);
    });

    $("#profileBtn").onclick = () => { if (confirm("Se déconnecter ?")) logout(); };

    // Sidebar mobile
    $("#menuBtn").onclick = toggleSidebar;
    $("#sidebarBackdrop").onclick = closeSidebar;
    window.addEventListener("resize", () => { syncTopbarHeight(); if (!isMobile()) closeSidebar(); });

    // Lecteur LIVE
    $("#liveModeBtn").onclick = toggleLiveMode;
    $("#liveReload").onclick = reloadLive;
    $("#liveFav").onclick = toggleCurrentLiveFav;
    $("#liveFs").onclick = liveFullscreen;

    // Lecteur VOD
    $("#closePlayer").onclick = closeVodPlayer;
    $("#playerOverlay").addEventListener("click", (e) => { if (e.target.id === "playerOverlay") closeVodPlayer(); });

    // Détail
    $("#closeDetail").onclick = closeDetail;
    $("#detailOverlay").addEventListener("click", (e) => { if (e.target.id === "detailOverlay") closeDetail(); });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#playerOverlay").classList.contains("hidden")) closeVodPlayer();
        else if (!$("#detailOverlay").classList.contains("hidden")) closeDetail();
        else if ($("#sidebar").classList.contains("open")) closeSidebar();
      }
    });
  }

  function init() { bindEvents(); renderSavedProfiles(); }
  document.addEventListener("DOMContentLoaded", init);
})();
