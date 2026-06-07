<?php
/**
 * proxy.php
 * Proxy CORS + streaming pour contourner le refus du navigateur (CORS / MSE).
 * - Passe les appels API Xtream (JSON) en transparence
 * - Réécrit les playlists HLS (.m3u8) pour que les segments repassent par le proxy
 * - Diffuse en flux (streaming) les segments .ts et les flux live mpegts
 *
 * Usage : proxy.php?url=<URL_ENCODEE>
 */

error_reporting(0);
@set_time_limit(0);
@ini_set('max_execution_time', '0');
@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
    header('Access-Control-Allow-Headers: *');
    header('Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges');
    exit;
}

$target = isset($_GET['url']) ? $_GET['url'] : '';
if ($target === '') {
    http_response_code(400);
    echo 'Missing url';
    exit;
}
$target = urldecode($target);

if (!preg_match('#^https?://#i', $target)) {
    http_response_code(400);
    echo 'Invalid url';
    exit;
}

if (!function_exists('curl_init')) {
    http_response_code(500);
    echo 'cURL non disponible sur ce serveur (active l\'extension php-curl).';
    exit;
}

/* Resout une URL relative en URL absolue */
function resolve_url($u, $base, $schemeHost) {
    if (preg_match('#^https?://#i', $u)) return $u;
    if (strlen($u) && $u[0] === '/')   return $schemeHost . $u;
    return $base . $u;
}

$userAgent = 'VLC/3.0.20 LibVLC/3.0.20';
$isPlaylist = (bool) preg_match('#\.m3u8(\?|$)#i', $target);

/* ---------- Cas 1 : playlist HLS -> on télécharge, on réécrit, on renvoie ---------- */
if ($isPlaylist) {
    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_USERAGENT      => $userAgent,
    ]);
    $data = curl_exec($ch);
    $eff  = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);

    header('Content-Type: application/vnd.apple.mpegurl');
    header('Access-Control-Allow-Origin: *');
    header('Cache-Control: no-cache');

    if ($data === false || $data === '') { exit; }

    $self       = strtok($_SERVER['REQUEST_URI'], '?');               // chemin vers proxy.php
    $base       = preg_replace('#/[^/]*$#', '/', $eff);               // dossier de la playlist
    $schemeHost = preg_replace('#^(https?://[^/]+).*#i', '$1', $eff); // http(s)://host

    $lines = preg_split('/\r?\n/', $data);
    $out   = [];
    foreach ($lines as $line) {
        $t = trim($line);
        if ($t === '') { $out[] = $line; continue; }

        if ($t[0] === '#') {
            // Réécrit les URI="..." (clés AES, médias alternatifs, etc.)
            if (preg_match('#URI="([^"]+)"#', $t, $m)) {
                $abs = resolve_url($m[1], $base, $schemeHost);
                $t = str_replace($m[1], $self . '?url=' . urlencode($abs), $t);
            }
            $out[] = $t;
            continue;
        }

        // Ligne d'URL (segment ou sous-playlist)
        $abs   = resolve_url($t, $base, $schemeHost);
        $out[] = $self . '?url=' . urlencode($abs);
    }

    echo implode("\n", $out);
    exit;
}

/* ---------- Cas 2 : JSON API / segments .ts / flux live / VOD -> streaming brut ----------
   Important : on relaie l'en-tête Range du navigateur et on renvoie le statut + les
   en-têtes (Content-Range, Accept-Ranges, Content-Length) du serveur d'origine.
   C'est ce qui permet d'AVANCER/RECULER dans un film (sinon il se comporte comme du live). */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges');

// En-têtes transmis au serveur d'origine
$fwdHeaders = ['Connection: keep-alive'];
if (isset($_SERVER['HTTP_RANGE']) && $_SERVER['HTTP_RANGE'] !== '') {
    $fwdHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
}

$isHead = ($_SERVER['REQUEST_METHOD'] === 'HEAD');

$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT        => 0,
    CURLOPT_USERAGENT      => $userAgent,
    CURLOPT_HTTPHEADER     => $fwdHeaders,
    CURLOPT_NOBODY         => $isHead,
    CURLOPT_BUFFERSIZE     => 16384,
    CURLOPT_HEADER         => false,
    CURLOPT_HEADERFUNCTION => function ($ch, $headerLine) {
        $line = trim($headerLine);
        // Statut HTTP d'origine (ex : 206 Partial Content pour une lecture avec Range)
        if (preg_match('#^HTTP/\d(?:\.\d)?\s+(\d{3})#i', $line, $m)) {
            http_response_code((int) $m[1]);
            return strlen($headerLine);
        }
        // On relaie les en-têtes utiles à la lecture VOD (seek) et au type de contenu
        $lower = strtolower($line);
        foreach (['content-type:', 'content-length:', 'content-range:', 'accept-ranges:'] as $h) {
            if (strpos($lower, $h) === 0) { header($line); break; }
        }
        return strlen($headerLine);
    },
    CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) {
        echo $chunk;
        @ob_flush();
        @flush();
        return strlen($chunk);
    },
]);

while (ob_get_level() > 0) { @ob_end_flush(); }
// Indique au navigateur que la ressource accepte les requêtes Range (utile si l'origine l'omet)
header('Accept-Ranges: bytes');
curl_exec($ch);
curl_close($ch);
