// AWS Secrets Manager client — single source of truth for all TSI platform credentials
// Secrets live in us-east-1 under the tsi/ namespace

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: 'us-east-1' });

// Cache secrets in-process to avoid redundant AWS calls within a single request
const cache = new Map<string, Record<string, string>>();

async function getSecret(secretName: string): Promise<Record<string, string>> {
  if (cache.has(secretName)) {
    return cache.get(secretName)!;
  }

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} has no string value`);
  }

  const parsed = JSON.parse(response.SecretString) as Record<string, string>;
  cache.set(secretName, parsed);
  return parsed;
}

// Typed accessors for each platform secret

// Secret key names are snake_case as stored in AWS Secrets Manager

export async function getFalconCredentials() {
  const s = await getSecret('tsi/mcp/falcon');
  return {
    apiKey: s['api_key'],
    endpoint: s['endpoint'] ?? 'https://falcon.tsi.tools/api/graphql',
    headerName: s['header_name'] ?? 'x-api-key',
  };
}

export async function getGbpCredentials() {
  const s = await getSecret('tsi/mcp/gbp');
  return {
    clientId: s['client_id'],
    clientSecret: s['client_secret'],
    refreshToken: s['refresh_token'],
  };
}

export async function getDudaCredentials() {
  const s = await getSecret('tsi/mcp/duda');
  return {
    username: s['username'],
    password: s['password'],
    baseUrl: 'https://api.duda.co',
  };
}

export async function getYextCredentials() {
  const s = await getSecret('tsi/mcp/yext');
  return {
    apiKey: s['api_key'],
    endpoint: s['endpoint'] ?? 'https://api.yext.com/v2',
  };
}

export async function getVcitaCredentials() {
  const s = await getSecret('tsi/mcp/vcita');
  return {
    token: s['token'],
  };
}

// Anthropic API key — stored as Vercel env var ANTHROPIC_API_KEY (not AWS)
export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY env var is not set');
  return key;
}

export async function getSociCredentials() {
  const s = await getSecret('tsi/mcp/soci');
  return {
    apiKey: s['api_key'],
    baseUrl: 'https://app.meetsoci.com/api',
    accountId: '3232', // Townsquare Interactive SOCI account ID
  };
}

export async function getFreshdeskCredentials() {
  const s = await getSecret('tsi/mcp/freshdesk');
  const domain = s['domain'];
  // Stored as bare subdomain ("townsquare") — build full hostname
  const fullDomain = domain.includes('.') ? domain : `${domain}.freshdesk.com`;
  return {
    apiKey: s['api_key'],
    domain: fullDomain,
  };
}
