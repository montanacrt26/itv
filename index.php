<?php /* XENON • Lecteur IPTV Web (HTML/PHP) */ ?>
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0f14" />
  <title>XENON • Lecteur IPTV</title>
  <?php
    /* Cache-busting automatique : la date de modif du fichier force le rechargement
       à chaque mise à jour -> fini les anciennes versions en cache du navigateur. */
    $cssV = @filemtime(__DIR__ . '/assets/css/style.css') ?: time();
    $jsV  = @filemtime(__DIR__ . '/assets/js/app.js') ?: time();
  ?>
  <link rel="stylesheet" href="assets/css/style.css?v=<?php echo $cssV; ?>" />
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"></script>
</head>
<body>

  <!-- ============ ÉCRAN DE CONNEXION ============ -->
  <div id="loginScreen" class="login-screen">
    <div class="login-bg"></div>
    <div class="login-card">
      <div class="brand">
        <div class="brand-mark">X</div>
        <div>
          <h1 class="brand-name">XENON</h1>
          <p class="brand-sub">Lecteur IPTV</p>
        </div>
      </div>

      <div class="tabs-login">
        <button class="tab-login active" data-mode="xtream">Code Xtream</button>
        <button class="tab-login" data-mode="m3u">Lien M3U</button>
      </div>

      <form id="xtreamForm" class="login-form">
        <label>Nom du profil
          <input type="text" id="x_name" placeholder="Mon abonnement" autocomplete="off" />
        </label>
        <label>Hôte / URL du serveur
          <input type="text" id="x_host" placeholder="http://exemple.com:8080" autocomplete="off" />
        </label>
        <label>Nom d'utilisateur
          <input type="text" id="x_user" placeholder="username" autocomplete="off" />
        </label>
        <label>Mot de passe
          <input type="text" id="x_pass" placeholder="password" autocomplete="off" />
        </label>
        <button type="submit" class="btn-primary">Se connecter</button>
      </form>

      <form id="m3uForm" class="login-form hidden">
        <label>Nom du profil
          <input type="text" id="m_name" placeholder="Mon abonnement" autocomplete="off" />
        </label>
        <label>Lien M3U (get.php)
          <input type="text" id="m_url" placeholder="http://serveur/get.php?username=...&password=..." autocomplete="off"
                 value="http://rcwksgdy.sqhsm.com/get.php?username=Z6E3UP4A&password=XJHUWMAN&type=m3u_plus&output=mpegts" />
        </label>
        <button type="submit" class="btn-primary">Se connecter</button>
      </form>

      <div id="loginError" class="login-error hidden"></div>

      <div id="savedProfiles" class="saved-profiles"></div>

      <p class="login-hint">Les identifiants sont enregistrés dans le <b>localStorage</b> de ton navigateur.</p>
    </div>
  </div>

  <!-- ============ APPLICATION ============ -->
  <div id="app" class="app hidden">
    <header class="topbar">
      <div class="topbar-left">
        <div class="brand-mark small">X</div>
        <span class="topbar-title">XENON</span>
      </div>
      <nav class="nav-tabs">
        <button class="nav-tab active" data-section="live">Live TV</button>
        <button class="nav-tab" data-section="vod">Films</button>
        <button class="nav-tab" data-section="series">Séries</button>
      </nav>
      <div class="topbar-right">
        <input type="search" id="searchInput" class="search" placeholder="Rechercher..." />
        <button id="profileBtn" class="icon-btn" title="Profil / Déconnexion">
          <span id="profileInitial">?</span>
        </button>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-title">Catégories</div>
        <div id="categoryList" class="category-list"></div>
      </aside>

      <main class="content">

        <!-- ----- VUE LIVE : lecteur + liste des chaînes ----- -->
        <section id="liveView" class="live-view">
          <div class="player-pane">
            <div class="now-playing">
              <span class="live-badge"><span class="np-dot"></span>LIVE</span>
              <span id="nowPlaying" class="np-title">Choisis une chaîne dans la liste &rarr;</span>
            </div>
            <div class="video-wrap">
              <video id="liveVideo" controls playsinline></video>
              <div id="liveStatus" class="player-status">Sélectionne une chaîne pour démarrer.</div>
            </div>
            <div class="player-bar">
              <button id="liveModeBtn" class="chip" title="Changer de moteur">Moteur : HLS</button>
              <button id="liveReload" class="chip" title="Recharger le flux">↻ Recharger</button>
              <button id="liveFs" class="chip" title="Plein écran">⛶ Plein écran</button>
            </div>
          </div>

          <aside class="channel-rail">
            <div class="rail-head" id="railTitle">Chaînes</div>
            <div id="channelList" class="channel-list"></div>
            <div id="railLoader" class="rail-loader hidden"><div class="spinner small"></div></div>
            <div id="railEmpty" class="rail-empty hidden">Aucune chaîne.</div>
          </aside>
        </section>

        <!-- ----- VUE FILMS / SÉRIES : grille ----- -->
        <section id="vodView" class="vod-view hidden">
          <div id="contentHeader" class="content-header"></div>
          <div id="grid" class="grid"></div>
          <div id="loader" class="loader hidden"><div class="spinner"></div></div>
          <div id="emptyState" class="empty-state hidden">Aucun élément à afficher.</div>
        </section>

      </main>
    </div>
  </div>

  <!-- ============ LECTEUR VOD (films / séries) ============ -->
  <div id="playerOverlay" class="player-overlay hidden">
    <div class="player-box">
      <div class="player-head">
        <div class="player-title" id="playerTitle">Lecture</div>
        <button id="closePlayer" class="icon-btn close" title="Fermer">✕</button>
      </div>
      <div class="video-wrap">
        <video id="vodVideo" controls autoplay playsinline></video>
        <div id="vodStatus" class="player-status"></div>
      </div>
    </div>
  </div>

  <!-- ============ DÉTAIL (films / séries) ============ -->
  <div id="detailOverlay" class="detail-overlay hidden">
    <div class="detail-box">
      <button id="closeDetail" class="icon-btn close detail-close" title="Fermer">✕</button>
      <div id="detailContent"></div>
    </div>
  </div>

  <script src="assets/js/app.js?v=<?php echo $jsV; ?>"></script>
</body>
</html>
