/**
 * Base API Adapter
 * 
 * Provides low-level fetch utilities for making requests to the Stellar Alerts API.
 * This adapter handles authentication headers and basic error handling.
 */

export interface ApiConfig {
  baseUrl: string;
  getAuthHeaders: () => Record<string, string>;
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function fetchApiResponse<T>(
  config: ApiConfig,
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...config.getAuthHeaders(),
      ...options?.headers,
    },
  });

  const data = await response.json().catch(() => ({})) as {
    success?: boolean;
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    throw new ApiRequestError(
      data.message || data.error || `API request failed: ${response.statusText}`,
      response.status,
    );
  }

  if (data.success !== true) {
    throw new ApiRequestError(data.error || 'API request returned unsuccessful response', response.status);
  }

  return data as T;
}

export class ApiAdapter {
  constructor(protected config: ApiConfig) {}

  protected async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return fetchApiResponse<T>(this.config, endpoint, options);
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.fetch<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.fetch<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.fetch<T>(endpoint, { method: 'DELETE' });
  }
}
