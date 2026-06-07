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
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: *');
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

/* ---------- Cas 2 : JSON API / segments .ts / flux live -> streaming brut ---------- */
header('Access-Control-Allow-Origin: *');

$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT        => 0,
    CURLOPT_USERAGENT      => $userAgent,
    CURLOPT_HTTPHEADER     => ['Connection: keep-alive'],
    CURLOPT_BUFFERSIZE     => 16384,
    CURLOPT_HEADER         => false,
    CURLOPT_HEADERFUNCTION => function ($ch, $headerLine) {
        // On transfère uniquement le Content-Type d'origine
        if (stripos($headerLine, 'Content-Type:') === 0) {
            header(trim($headerLine));
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
curl_exec($ch);
curl_close($ch);
