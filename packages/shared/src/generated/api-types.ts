/**
 * AUTO-GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Generated from the Fastify OpenAPI schema in apps/api/src/openapi.config.ts by
 * `npm run generate:types` (see scripts/generate-types.ts). Run that
 * command again after changing a Zod schema referenced by
 * `openApiComponentSchemas`, and commit the result.
 */
export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        RequestLinkInput: {
            /** Format: email */
            email: string;
        };
        VerifyLinkInput: {
            token: string;
        };
        DIDChallengeInput: {
            did: string;
        };
        DIDVerifyInput: {
            did: string;
            challenge: string;
            signature: string;
        };
        CreateWalletInput: {
            publicKey: string;
            label?: string;
            zkProof?: unknown;
            publicSignals?: string[];
        };
        CreateWebhookInput: {
            /** Format: uri */
            url: string;
            payloadTemplate?: string;
        };
        DeadLetterIdParams: {
            id: string;
        };
        ListDeadLettersQuery: {
            channel?: string;
            /** @enum {string} */
            status?: "pending" | "retried" | "suppressed";
            q?: string;
            maxAgeDays?: number;
            /** @default 1 */
            page: number;
            /** @default 20 */
            pageSize: number;
        };
        SuppressDeadLetterInput: {
            note?: string;
        };
        SandboxReplayIdParams: {
            replayId: string;
        };
        SandboxReplayInput: {
            /**
             * @default {
             *       "status": 200,
             *       "headers": {},
             *       "body": "",
             *       "delayMs": 0
             *     }
             */
            mockResponse: {
                /** @default 200 */
                status: number;
                /** @default {} */
                headers: {
                    [key: string]: string;
                };
                /** @default  */
                body: string;
                /** @default 0 */
                delayMs: number;
            };
        };
        ListSandboxReplaysQuery: {
            /** @enum {string} */
            status?: "completed" | "failed";
            /** @default 1 */
            page: number;
            /** @default 20 */
            pageSize: number;
        };
        AnalyzeTransactionInput: {
            envelopeXdr: string;
            networkPassphrase: string;
            simulation?: {
                status?: string;
                costCpuInsns?: string;
                costMemBytes?: string;
                readOnlyLedgerKeys?: string[];
                readWriteLedgerKeys?: string[];
                archivedLedgerKeys?: string[];
                restoreRequired?: boolean;
            } | null;
            ledgerBaseline?: {
                nativeBalanceStroops?: string;
                knownRecipients?: string[];
                trustedContracts?: string[];
            } | null;
            options?: {
                drainExhaustionRatio?: number;
                drainSplitDestinationThreshold?: number;
                dustResidueStroops?: number;
                ttlExtensionLedgerThreshold?: number;
                cpuInstructionThreshold?: number;
                maxFootprintEntries?: number;
                pathPaymentAsymmetryRatio?: number;
                footprintExpansionRatio?: number;
            } | null;
            persist?: boolean;
        };
        ErrorResponse: {
            error: {
                /** @description Stable, machine-readable error code (e.g. VALIDATION_ERROR, NOT_FOUND, CONFLICT). */
                code: string;
                /** @description Human-readable, client-safe message. Never contains internal/sensitive detail. */
                message: string;
                /** @description Optional structured detail, e.g. field-level validation errors. */
                details?: unknown;
                /** @description Correlation id — also returned as the x-request-id response header. */
                requestId: string;
            };
        };
        CreateExportInput: {
            /** @enum {string} */
            type: "ledger_csv" | "ledger_pdf" | "tax_csv";
            walletId?: string;
            periodStart?: string;
            periodEnd?: string;
            /** @enum {string} */
            format?: "cointracker" | "koinly" | "irs8949";
        };
        ExportIdParams: {
            id: string;
        };
        ListExportsQuery: {
            /** @default 1 */
            page: number;
            /** @default 20 */
            pageSize: number;
        };
        DownloadExportQuery: {
            expires: number;
            sig: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
