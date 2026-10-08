/**
 * Public surface of the pre-execution simulation engine.
 *
 * Import from `@/services/simulation` (or the relative equivalent) rather than
 * from individual files, so the internal split — amounts / footprint-diff /
 * drain-detector / contract-trust / envelope-integrity / risk-scorer / engine —
 * stays free to change without rippling through call sites.
 */

export * from './types';
export * from './amounts';
export * from './footprint-diff';
export * from './drain-detector';
export * from './contract-trust';
export * from './envelope-integrity';
export * from './risk-scorer';
export * from './simulation-engine';
