/**
 * Security utilities for mcp-web-docs
 * Handles encryption, input sanitization, and validation
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'node:crypto';
import { z } from 'zod';
import safeRegex from 'safe-regex2';

// Encryption configuration
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Derive an encryption key from a machine-specific identifier
 * This provides basic protection for stored credentials
 */
function deriveKey(salt: Buffer): Buffer {
  // Use a combination of factors for the key derivation
  // In production, consider using a proper secret management system
  const machineId = process.env.MCP_WEB_DOCS_SECRET || `${process.env.HOME || ''}:${process.platform}:mcp-web-docs`;
  return scryptSync(machineId, salt, KEY_LENGTH);
}

/**
 * Encrypt sensitive data using AES-256-GCM
 * @param plaintext - Data to encrypt
 * @returns Encrypted data as base64 string with embedded IV, salt, and auth tag
 */
export function encryptData(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  // Combine salt + iv + authTag + encrypted data
  const combined = Buffer.concat([
    salt,
    iv,
    authTag,
    Buffer.from(encrypted, 'base64'),
  ]);

  return combined.toString('base64');
}

/**
 * Decrypt data encrypted with encryptData
 * @param encryptedData - Base64 encoded encrypted data
 * @returns Decrypted plaintext
 */
export function decryptData(encryptedData: string): string {
  const combined = Buffer.from(encryptedData, 'base64');

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Escape special characters for LanceDB filter expressions
 * Prevents SQL/filter injection attacks
 * @param value - User-provided value to escape
 * @returns Escaped value safe for use in filter expressions
 */
export function escapeFilterValue(value: string): string {
  if (typeof value !== 'string') {
    throw new Error('Filter value must be a string');
  }

  // Escape single quotes by doubling them (SQL-style escaping)
  // Also escape backslashes to prevent escape sequence injection
  return value
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/'/g, "''") // Escape single quotes
    .replace(/\0/g, '') // Remove null bytes
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ''); // Remove control characters
}

/**
 * Validate and sanitize a URL for safe usage
 * Prevents SSRF attacks by blocking private/internal networks
 * @param urlString - URL to validate
 * @returns Validated URL object
 * @throws Error if URL is invalid or points to private network
 */
export function validatePublicUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Only allow http and https protocols
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are allowed');
  }

  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.localhost')
  ) {
    throw new Error('Access to localhost is not allowed');
  }

  // Block private IP ranges (basic check)
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 10.0.0.0/8
    if (a === 10) {
      throw new Error('Access to private networks is not allowed');
    }
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) {
      throw new Error('Access to private networks is not allowed');
    }
    // 192.168.0.0/16
    if (a === 192 && b === 168) {
      throw new Error('Access to private networks is not allowed');
    }
    // 169.254.0.0/16 (link-local, includes cloud metadata)
    if (a === 169 && b === 254) {
      throw new Error('Access to link-local addresses is not allowed');
    }
    // 127.0.0.0/8
    if (a === 127) {
      throw new Error('Access to loopback addresses is not allowed');
    }
  }

  // Block common cloud metadata endpoints
  if (
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata' ||
    hostname.includes('169.254')
  ) {
    throw new Error('Access to cloud metadata endpoints is not allowed');
  }

  return url;
}

/**
 * Check if a regex pattern is safe (not vulnerable to ReDoS)
 * Uses safe-regex2 from https://github.com/fastify/safe-regex2
 * @param pattern - Regex pattern string to check
 * @returns true if pattern is safe, false if potentially dangerous
 */
export function isSafeRegex(pattern: string): boolean {
  try {
    // Validate it's a valid regex first
    new RegExp(pattern);
    // Then check for ReDoS vulnerability
    return safeRegex(pattern);
  } catch {
    // Invalid regex is not safe
    return false;
  }
}

/**
 * Create a safe RegExp from user input with ReDoS protection
 * @param pattern - User-provided regex pattern
 * @param flags - Optional regex flags
 * @returns RegExp object
 * @throws Error if pattern is unsafe or invalid
 */
export function createSafeRegex(pattern: string, flags?: string): RegExp {
  if (!isSafeRegex(pattern)) {
    throw new Error('Unsafe regex pattern: may cause catastrophic backtracking (ReDoS)');
  }
  return new RegExp(pattern, flags);
}

// ============ Zod Schemas for Input Validation ============

/**
 * Schema for browser storage state (cookies and localStorage)
 */
export const StorageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
    })
  ),
  origins: z
    .array(
      z.object({
        origin: z.string(),
        localStorage: z.array(
          z.object({
            name: z.string(),
            value: z.string(),
          })
        ),
      })
    )
    .optional(),
});

export type ValidatedStorageState = z.infer<typeof StorageStateSchema>;

/**
 * Schema for stored session data
 */
export const StoredSessionSchema = z.object({
  domain: z.string(),
  storageState: z.string(), // This is encrypted
  createdAt: z.string(),
  browser: z.enum(['chromium', 'chrome', 'firefox', 'webkit', 'edge']),
  version: z.literal(2), // Schema version for migration support
});

/** Validated stored session type */
export type ValidatedStoredSession = z.infer<typeof StoredSessionSchema>;

/**
 * Schema for GitHub API file response
 */
export const GitHubFileSchema = z.object({
  path: z.string(),
  type: z.enum(['file', 'dir']),
  url: z.string(),
  content: z.string().optional(),
});

export const GitHubFilesArraySchema = z.array(GitHubFileSchema);

export type ValidatedGitHubFile = z.infer<typeof GitHubFileSchema>;

/**
 * Safely parse JSON with schema validation
 * @param jsonString - JSON string to parse
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws Error if JSON is invalid or doesn't match schema
 */
export function safeJsonParse<T>(jsonString: string, schema: z.ZodSchema<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Generate a secure hash for cache keys or identifiers
 * @param input - String to hash
 * @returns SHA-256 hash as hex string
 */
export function secureHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ============ MCP Tool Argument Validation Schemas ============

/** Browser type enum for authentication */
const BrowserTypeEnum = z.enum(['chromium', 'chrome', 'firefox', 'webkit', 'edge']);

/**
 * Schema for add_documentation tool arguments
 */
export const AddDocumentationArgsSchema = z.object({
  url: z.string().url().max(2048),
  title: z.string().max(500).optional(),
  id: z
    .string()
    .regex(/^[a-zA-Z0-9-_]+$/, 'ID must contain only alphanumeric characters, hyphens, and underscores')
    .max(100)
    .optional(),
  auth: z
    .object({
      requiresAuth: z.boolean().optional(),
      browser: BrowserTypeEnum.optional(),
      loginUrl: z.string().url().max(2048).optional(),
      loginSuccessPattern: z.string().max(500).optional(),
      loginSuccessSelector: z.string().max(500).optional(),
      loginTimeoutSecs: z.number().min(10).max(600).optional(),
    })
    .optional(),
});

export type AddDocumentationArgs = z.infer<typeof AddDocumentationArgsSchema>;

/**
 * Schema for authenticate tool arguments
 */
export const AuthenticateArgsSchema = z.object({
  url: z.string().url().max(2048),
  browser: BrowserTypeEnum.optional(),
  loginUrl: z.string().url().max(2048).optional(),
  loginTimeoutSecs: z.number().min(10).max(600).optional(),
});

export type AuthenticateArgs = z.infer<typeof AuthenticateArgsSchema>;

/**
 * Schema for clear_auth tool arguments
 */
export const ClearAuthArgsSchema = z.object({
  url: z.string().url().max(2048),
});

export type ClearAuthArgs = z.infer<typeof ClearAuthArgsSchema>;

/**
 * Schema for search_documentation tool arguments
 */
export const SearchDocumentationArgsSchema = z.object({
  query: z.string().min(1).max(1000),
  url: z.string().url().max(2048).optional(),
  limit: z.number().min(1).max(100).optional(),
});

export type SearchDocumentationArgs = z.infer<typeof SearchDocumentationArgsSchema>;

/**
 * Schema for reindex_documentation tool arguments
 */
export const ReindexDocumentationArgsSchema = z.object({
  url: z.string().url().max(2048),
});

export type ReindexDocumentationArgs = z.infer<typeof ReindexDocumentationArgsSchema>;

/**
 * Schema for delete_documentation tool arguments
 */
export const DeleteDocumentationArgsSchema = z.object({
  url: z.string().url().max(2048),
  clearAuth: z.boolean().optional(),
});

export type DeleteDocumentationArgs = z.infer<typeof DeleteDocumentationArgsSchema>;

/**
 * Validate MCP tool arguments against a schema
 * @param args - Raw arguments from MCP request
 * @param schema - Zod schema to validate against
 * @returns Validated and typed arguments
 * @throws Error with user-friendly message if validation fails
 */
export function validateToolArgs<T>(args: Record<string, unknown> | undefined, schema: z.ZodSchema<T>): T {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    // Format Zod errors into a readable message
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid arguments: ${errors}`);
  }
  return result.data;
}

