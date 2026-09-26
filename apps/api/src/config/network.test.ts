import { describe, expect, it } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import { resolveStellarNetworkProfile } from './network';

describe('resolveStellarNetworkProfile', () => {
  it('defaults to testnet and ignores legacy endpoint overrides without explicit custom selection', () => {
    const profile = resolveStellarNetworkProfile({
      HORIZON_URL: 'https://horizon.example.com',
      SOROBAN_RPC_URL: 'https://rpc.example.com',
      STELLAR_NETWORK_PASSPHRASE: 'Unexpected Network',
    });

    expect(profile.profile).toBe('testnet');
    expect(profile.horizonEndpoints[0]).toBe('https://horizon-testnet.stellar.org');
    expect(profile.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(profile.networkPassphrase).toBe(StellarSdk.Networks.TESTNET);
  });

  it('selects the complete mainnet profile', () => {
    const profile = resolveStellarNetworkProfile({ STELLAR_NETWORK_PROFILE: 'mainnet' });

    expect(profile).toEqual({
      profile: 'mainnet',
      horizonEndpoints: [
        'https://horizon.stellar.org',
        'https://stellar-horizon.publicnode.org',
        'https://horizon.lobstr.co',
      ],
      sorobanRpcUrl: 'https://soroban.stellar.org',
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    });
  });

  it('requires every custom endpoint to use an explicitly allowed host', () => {
    expect(() => resolveStellarNetworkProfile({
      STELLAR_NETWORK_PROFILE: 'custom',
      STELLAR_CUSTOM_HORIZON_URL: 'https://horizon.example.com',
      STELLAR_CUSTOM_SOROBAN_RPC_URL: 'https://rpc.example.com',
      STELLAR_CUSTOM_NETWORK_PASSPHRASE: 'Custom Network',
      STELLAR_CUSTOM_ALLOWED_HOSTS: 'horizon.example.com',
    })).toThrow('rpc.example.com');
  });

  it('accepts legacy endpoint variables only inside an explicit custom profile', () => {
    const profile = resolveStellarNetworkProfile({
      STELLAR_NETWORK_PROFILE: 'custom',
      HORIZON_URL: 'https://horizon.example.com/',
      HORIZON_URL_NODE2: 'https://horizon-2.example.com',
      SOROBAN_RPC_URL: 'https://rpc.example.com',
      STELLAR_NETWORK_PASSPHRASE: 'Custom Network',
      STELLAR_CUSTOM_ALLOWED_HOSTS: 'horizon.example.com,horizon-2.example.com,rpc.example.com',
    });

    expect(profile.horizonEndpoints).toEqual([
      'https://horizon.example.com',
      'https://horizon-2.example.com',
    ]);
    expect(profile.networkPassphrase).toBe('Custom Network');
  });
});