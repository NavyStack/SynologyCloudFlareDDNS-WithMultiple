#!/usr/bin/php -d open_basedir=/usr/syno/bin/ddns
<?php

declare(strict_types=1);

const STATUS_GOOD = 'good';
const STATUS_NOCHG = 'nochg';
const STATUS_BAD_AUTH = 'badauth';
const STATUS_BAD_PARAM = 'badparam';
const STATUS_NO_HOST = 'nohost';
const STATUS_NUM_HOST = 'numhost';
const STATUS_ERROR = '911';

const SUCCESS_STATUSES = [STATUS_GOOD, STATUS_NOCHG];

const USER_AGENT = 'Synology-DDNS-Helper';
const REQUEST_TIMEOUT = 15;
const CONNECT_TIMEOUT = 10;
const HOSTNAME_DELIMITER = '---';
const TOKEN_BEARER_PREFIX = 'cfut_';

const CF_AUTH_ERROR_CODES = [6003, 6111, 7000, 7003, 9106, 9109, 9111, 9201, 10000];

if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool {
        return strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_contains')) {
    function str_contains(string $haystack, string $needle): bool {
        return $needle === '' || strpos($haystack, $needle) !== false;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}

class AuthError extends RuntimeException {}

main();

function main(): void {
    global $argc, $argv;

    if ($argc !== 5) {
        exitWith(STATUS_BAD_PARAM);
    }
    [, $account, $secret, $hostnamesArg, $ip] = $argv;

    $recordType = detectRecordType($ip);
    if ($recordType === null) {
        exitWith(STATUS_BAD_PARAM);
    }

    $hostnames = array_values(array_filter(
        array_map('trim', explode(HOSTNAME_DELIMITER, $hostnamesArg)),
        static fn(string $h): bool => $h !== ''
    ));
    if (empty($hostnames)) {
        exitWith(STATUS_BAD_PARAM);
    }
    foreach ($hostnames as $h) {
        if (!isValidHostname($h)) {
            exitWith(STATUS_BAD_PARAM);
        }
    }

    $headers = buildAuthHeaders($account, $secret);

    try {
        $zones = fetchAllZones($headers);
        $results = [];
        foreach ($hostnames as $hostname) {
            $results[] = processHost($hostname, $ip, $recordType, $zones, $headers);
        }
        exitWith(summarize($results));
    } catch (AuthError $e) {
        fwrite(STDERR, 'auth failed: ' . $e->getMessage() . PHP_EOL);
        exitWith(STATUS_BAD_AUTH);
    } catch (Throwable $e) {
        fwrite(STDERR, 'unexpected error: ' . $e->getMessage() . PHP_EOL);
        exitWith(STATUS_ERROR);
    }
}

function exitWith(string $status): void {
    echo $status;
    exit(in_array($status, SUCCESS_STATUSES, true) ? 0 : 1);
}

function isValidHostname(string $hostname): bool {
    if (strlen($hostname) < 1 || strlen($hostname) > 253) {
        return false;
    }
    return (bool) preg_match(
        '/^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/',
        $hostname
    );
}

function detectRecordType(string $ip): ?string {
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        return 'A';
    }
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
        return 'AAAA';
    }
    return null;
}

function buildAuthHeaders(string $account, string $secret): array {
    $base = ['Content-Type: application/json', 'User-Agent: ' . USER_AGENT];
    if (str_starts_with($secret, TOKEN_BEARER_PREFIX)) {
        return array_merge($base, ['Authorization: Bearer ' . $secret]);
    }
    if (preg_match('/^[0-9a-z]{37}$/i', $secret) === 1 && str_contains($account, '@')) {
        return array_merge($base, [
            'X-Auth-Email: ' . $account,
            'X-Auth-Key: ' . $secret,
        ]);
    }
    return array_merge($base, ['Authorization: Bearer ' . $secret]);
}

function buildComment(): string {
    return 'Set by github.com/fvoci/SynologyCloudFlareDDNS-WithMultiple on '
        . gmdate('Y-m-d\TH:i:s\Z');
}

function request(string $url, array $headers, string $method = 'GET', ?array $body = null): array {
    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException("curl_init failed for $url");
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_TIMEOUT => REQUEST_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    $response = curl_exec($ch);
    if ($response === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException("curl error: $err");
    }
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $decoded = json_decode((string) $response, true);
    if (!is_array($decoded)) {
        throw new RuntimeException("invalid json from $url");
    }
    return ['status' => $status, 'body' => $decoded];
}

function requestWithRetry(string $url, array $headers, string $method = 'GET', ?array $body = null): array {
    $lastErr = null;
    for ($attempt = 0; $attempt < 2; $attempt++) {
        try {
            $res = request($url, $headers, $method, $body);
            if ($res['status'] < 500) {
                return $res;
            }
            $lastErr = new RuntimeException("http {$res['status']} from $url");
        } catch (Throwable $e) {
            $lastErr = $e;
        }
        if ($attempt === 0) {
            usleep(500000);
        }
    }
    throw $lastErr ?? new RuntimeException("request failed: $url");
}

function unwrap(array $res) {
    $status = $res['status'];
    $body = $res['body'];
    if (!empty($body['success'])) {
        return $body['result'] ?? null;
    }
    $err = $body['errors'][0] ?? null;
    $message = $err['message'] ?? "http $status";
    $code = $err['code'] ?? null;
    $isAuth = $status === 401
        || $status === 403
        || ($code !== null && in_array($code, CF_AUTH_ERROR_CODES, true));
    if ($isAuth) {
        throw new AuthError($message);
    }
    throw new RuntimeException('cloudflare api error (' . ($code ?? $status) . "): $message");
}

function fetchAllZones(array $headers): array {
    $all = [];
    $page = 1;
    while (true) {
        $url = "https://api.cloudflare.com/client/v4/zones?per_page=50&page=$page";
        $res = requestWithRetry($url, $headers);
        $zones = unwrap($res) ?? [];
        $all = array_merge($all, $zones);
        $totalPages = $res['body']['result_info']['total_pages'] ?? 1;
        if ($page >= (int) $totalPages) {
            break;
        }
        $page++;
    }
    return $all;
}

function findZone(array $zones, string $hostname): ?array {
    $target = rtrim(strtolower($hostname), '.');
    $best = null;
    foreach ($zones as $zone) {
        $name = strtolower($zone['name']);
        if ($target === $name || str_ends_with($target, ".$name")) {
            if ($best === null || strlen($name) > strlen($best['name'])) {
                $best = $zone;
            }
        }
    }
    return $best;
}

function findRecords(string $zoneId, string $hostname, string $type, array $headers): array {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=$type&name="
        . rawurlencode($hostname);
    $res = requestWithRetry($url, $headers);
    return unwrap($res) ?? [];
}

function createRecord(string $zoneId, string $hostname, string $ip, string $type, array $headers): bool {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records";
    $body = [
        'type' => $type,
        'name' => $hostname,
        'content' => $ip,
        'ttl' => 120,
        'proxied' => false,
        'comment' => buildComment(),
    ];
    $res = requestWithRetry($url, $headers, 'POST', $body);
    return unwrap($res) !== null;
}

function updateRecord(string $zoneId, array $record, string $hostname, string $ip, string $type, array $headers): bool {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/{$record['id']}";
    $body = [
        'type' => $type,
        'name' => $hostname,
        'content' => $ip,
        'ttl' => $record['ttl'],
        'proxied' => $record['proxied'],
        'comment' => buildComment(),
    ];
    $res = requestWithRetry($url, $headers, 'PUT', $body);
    return unwrap($res) !== null;
}

function processHost(string $hostname, string $ip, string $type, array $zones, array $headers): string {
    $zone = findZone($zones, $hostname);
    if ($zone === null) {
        return STATUS_NO_HOST;
    }
    $records = findRecords($zone['id'], $hostname, $type, $headers);
    if (count($records) > 1) {
        return STATUS_NUM_HOST;
    }
    if (empty($records)) {
        return createRecord($zone['id'], $hostname, $ip, $type, $headers)
            ? STATUS_GOOD
            : STATUS_ERROR;
    }
    $existing = $records[0];
    if ($existing['content'] === $ip) {
        return STATUS_NOCHG;
    }
    return updateRecord($zone['id'], $existing, $hostname, $ip, $type, $headers)
        ? STATUS_GOOD
        : STATUS_ERROR;
}

function summarize(array $results): string {
    $priority = [STATUS_BAD_AUTH, STATUS_BAD_PARAM, STATUS_NO_HOST, STATUS_NUM_HOST, STATUS_ERROR];
    foreach ($priority as $status) {
        if (in_array($status, $results, true)) {
            return $status;
        }
    }
    return in_array(STATUS_GOOD, $results, true) ? STATUS_GOOD : STATUS_NOCHG;
}
