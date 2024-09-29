#!/usr/bin/php -d open_basedir=/usr/syno/bin/ddns
<?php

if ($argc !== 5) {
    exitWithMessage('badparam');
}

list(, $account, $pwd, $hostname, $ip) = $argv;

// Validate hostname and IP
if (!isValidHostname($hostname) || !isValidIP($ip)) {
    exitWithMessage('badparam');
}

$headers = buildAuthHeaders($account, $pwd);
if (!$headers) {
    exitWithMessage('badauth');
}

$zoneId = fetchZoneId($hostname, $headers);
if (!$zoneId) {
    exitWithMessage('nohost');
}

$recordInfo = fetchDnsRecordInfo($zoneId, $hostname, $headers);
$tagDescription = buildTagDescription();

if ($recordInfo) {
    $updateStatus = updateDnsRecord($zoneId, $recordInfo['id'], $hostname, $ip, $recordInfo['ttl'], $recordInfo['proxied'], $headers, $tagDescription);
    exitWithMessage($updateStatus ? 'good' : 'Update Record failed');
} else {
    $createStatus = createDnsRecord($zoneId, $hostname, $ip, $headers, $tagDescription);
    exitWithMessage($createStatus ? 'good' : 'Failed to create new record');
}

// ------------- Utility Functions ---------------

function exitWithMessage(string $message): void {
    echo $message;
    exit();
}

function isValidHostname(string $hostname): bool {
    return strpos($hostname, '.') !== false;
}

function isValidIP(string $ip): bool {
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
}

function buildAuthHeaders(string $account, string $pwd): ?array {
    if (strlen($pwd) === 37) {
        return ["X-Auth-Email: $account", "X-Auth-Key: $pwd", "Content-Type: application/json"];
    } elseif (strlen($pwd) === 40) {
        return ["Authorization: Bearer $pwd", "Content-Type: application/json"];
    }
    return null;
}

function buildTagDescription(): string {
    date_default_timezone_set('UTC'); // Set default timezone to UTC or change as needed
    return "Set by github.com/navystack via SynologyDDNSProject on " . date("Y-m-d H:i:s");
}

function executeCurlRequest(string $url, array $headers, string $method = 'GET', ?array $data = null): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CUSTOMREQUEST => $method,
    ]);

    if ($data) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    }

    $response = curl_exec($ch);
    if ($response === false) {
        logError("cURL error: " . curl_error($ch));
        curl_close($ch);
        return null;
    }

    $result = json_decode($response, true);
    curl_close($ch);

    if (!is_array($result) || !isset($result['success']) || !$result['success']) {
        $errorDetails = $result['errors'][0]['message'] ?? 'Unknown error';
        logError("API request failed with message: $errorDetails");
        return null;
    }

    return $result;
}

function logError(string $message): void {
    echo "Error: $message" . PHP_EOL;
}

function fetchZoneId(string $hostname, array $headers): ?string {
    $url = "https://api.cloudflare.com/client/v4/zones";
    $response = executeCurlRequest($url, $headers);

    if ($response && isset($response['result'])) {
        foreach ($response['result'] as $zone) {
            if (preg_match('/\.' . preg_quote($zone['name'], '/') . '$/i', $hostname) || strtolower($zone['name']) === strtolower($hostname)) {
                return $zone['id'];
            }
        }
    }
    return null;
}

function fetchDnsRecordInfo(string $zoneId, string $hostname, array $headers): ?array {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=A&name=$hostname";
    $response = executeCurlRequest($url, $headers);
    return $response['result'][0] ?? null;
}

function createDnsRecord(string $zoneId, string $hostname, string $ip, array $headers, string $tagDescription): bool {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records";
    $data = [
        'type' => 'A',
        'name' => $hostname,
        'content' => $ip,
        'ttl' => 120,
        'proxied' => false,
        'comment' => $tagDescription,
    ];

    return executeCurlRequest($url, $headers, 'POST', $data) !== null;
}

function updateDnsRecord(string $zoneId, string $recordId, string $hostname, string $ip, int $ttl, bool $proxied, array $headers, string $tagDescription): bool {
    $url = "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$recordId";
    $data = [
        'type' => 'A',
        'name' => $hostname,
        'content' => $ip,
        'ttl' => $ttl,
        'proxied' => $proxied,
        'comment' => $tagDescription,
    ];

    return executeCurlRequest($url, $headers, 'PUT', $data) !== null;
}
