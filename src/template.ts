#!/usr/bin/env node

import https from 'https';

// ------------------- Enums ---------------------

enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT'
}

enum ExitCode {
  BAD_PARAM = 'badparam',
  BAD_AUTH = 'badauth',
  NO_HOST = 'nohost',
  GOOD = 'good',
  UPDATE_FAILED = 'Update Record failed',
  CREATE_FAILED = 'Failed to create new record',
  ERROR = 'error'
}

// ------------------- Types & Interfaces ---------------------

interface ApiHeaders {
  [key: string]: string;
}

interface ApiError {
  code: number;
  message: string;
}

interface ApiResponse<T> {
  success: boolean;
  errors: ApiError[];
  messages: ApiError[];
  result?: T;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment: string;
}

interface Zone {
  id: string;
  name: string;
}

// Extract command-line arguments
const [account, pwd, hostname, ip] = process.argv.slice(2);

if (!account || !pwd || !hostname || !ip) {
  exitWithMessage(ExitCode.BAD_PARAM);
}

// Validate hostname and IP
if (!isValidHostname(hostname) || !isValidIP(ip)) {
  exitWithMessage(ExitCode.BAD_PARAM);
}

// Build authentication headers
const headers = buildAuthHeaders(account, pwd);
if (!headers) {
  exitWithMessage(ExitCode.BAD_AUTH);
}

// Main execution
(async () => {
  try {
    const zoneId = await fetchZoneId(hostname, headers);
    if (!zoneId) exitWithMessage(ExitCode.NO_HOST);

    const recordInfo = await fetchDnsRecordInfo(zoneId, hostname, headers);
    const tagDescription = buildTagDescription();

    if (recordInfo) {
      const updateStatus = await updateDnsRecord(
        zoneId,
        recordInfo.id,
        hostname,
        ip,
        recordInfo.ttl,
        recordInfo.proxied,
        headers,
        tagDescription
      );
      exitWithMessage(updateStatus ? ExitCode.GOOD : ExitCode.UPDATE_FAILED);
    } else {
      const createStatus = await createDnsRecord(
        zoneId,
        hostname,
        ip,
        headers,
        tagDescription
      );
      exitWithMessage(createStatus ? ExitCode.GOOD : ExitCode.CREATE_FAILED);
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    exitWithMessage(ExitCode.ERROR);
  }
})();

// ------------- Utility Functions ---------------

function exitWithMessage(message: ExitCode): never {
  console.log(message);
  process.exit(1);
}

function isValidHostname(hostname: string): boolean {
  const hostnameRegex =
    /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;
  return hostnameRegex.test(hostname);
}

function isValidIP(ip: string): boolean {
  const ipv4Regex =
    /^(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)\.(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
  return ipv4Regex.test(ip);
}

function buildAuthHeaders(account: string, pwd: string): ApiHeaders | null {
  if (pwd.length === 37) {
    return {
      'X-Auth-Email': account,
      'X-Auth-Key': pwd,
      'Content-Type': 'application/json'
    };
  } else if (pwd.length === 40) {
    return {
      Authorization: `Bearer ${pwd}`,
      'Content-Type': 'application/json'
    };
  }
  return null;
}

function buildTagDescription(): string {
  return `Set by github.com/navystack via SynologyDDNSProject on ${new Date().toISOString()}`;
}

function executeHttpsRequest<T>(
  url: string,
  headers: ApiHeaders,
  method: HttpMethod = HttpMethod.GET,
  data?: object
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      method,
      headers
    };

    const req = https.request(url, options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const result: ApiResponse<T> = JSON.parse(responseData);
          if (result && result.success) {
            resolve(result);
          } else {
            const errorDetails = result.errors?.[0]?.message || 'Unknown error';
            console.error(`API request failed with message: ${errorDetails}`);
            reject(new Error(errorDetails));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function fetchZoneId(
  hostname: string,
  headers: ApiHeaders
): Promise<string | null> {
  const url = 'https://api.cloudflare.com/client/v4/zones';
  try {
    const response = await executeHttpsRequest<Zone[]>(url, headers);
    if (response && response.result) {
      for (const zone of response.result) {
        if (
          hostname.toLowerCase() === zone.name.toLowerCase() ||
          hostname.toLowerCase().endsWith(`.${zone.name.toLowerCase()}`)
        ) {
          return zone.id;
        }
      }
    }
    return null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function fetchDnsRecordInfo(
  zoneId: string,
  hostname: string,
  headers: ApiHeaders
): Promise<DnsRecord | null> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(
    hostname
  )}`;
  try {
    const response = await executeHttpsRequest<DnsRecord[]>(url, headers);
    return response.result && response.result.length > 0
      ? response.result[0]
      : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function createDnsRecord(
  zoneId: string,
  hostname: string,
  ip: string,
  headers: ApiHeaders,
  tagDescription: string
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
  const data = {
    type: 'A',
    name: hostname,
    content: ip,
    ttl: 120,
    proxied: false,
    comment: tagDescription
  };

  try {
    const response = await executeHttpsRequest<DnsRecord>(
      url,
      headers,
      HttpMethod.POST,
      data
    );
    return !!response.result;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function updateDnsRecord(
  zoneId: string,
  recordId: string,
  hostname: string,
  ip: string,
  ttl: number,
  proxied: boolean,
  headers: ApiHeaders,
  tagDescription: string
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`;
  const data = {
    type: 'A',
    name: hostname,
    content: ip,
    ttl,
    proxied,
    comment: tagDescription
  };

  try {
    const response = await executeHttpsRequest<DnsRecord>(
      url,
      headers,
      HttpMethod.PUT,
      data
    );
    return !!response.result;
  } catch (error) {
    console.error(error);
    return false;
  }
}
