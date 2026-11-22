use serde::{Deserialize, Serialize};

/// A payment alert, matching `AlertJobData` in
/// `apps/api/src/lib/queue.ts` — the shape of a payment-triggered alert
/// before it is rendered through a webhook's (optional) custom Handlebars
/// template.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaymentAlert {
    pub payment_id: String,
    pub tx_hash: String,
    pub wallet_id: String,
    pub amount: String,
    pub asset: String,
    #[serde(default)]
    pub asset_issuer: Option<String>,
    pub from_address: String,
    pub received_at: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
}

/// A Soroban smart-contract event alert.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SorobanEvent {
    pub contract_id: String,
    pub ledger: u32,
    #[serde(default)]
    pub tx_hash: Option<String>,
    /// Decoded topic segments (e.g. `["transfer", "from", "to"]`).
    #[serde(default)]
    pub topic: Vec<String>,
    /// Decoded event value, left as raw JSON since its shape depends on
    /// the emitting contract.
    #[serde(default)]
    pub value: serde_json::Value,
}

/// A Soroban host resource saturation alert event (#972).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SorobanSaturationAlert {
    pub contract_id: String,
    #[serde(default)]
    pub tx_hash: Option<String>,
    #[serde(default)]
    pub ledger_seq: Option<u32>,
    pub severity: String,
    pub overall_saturation_percent: f64,
    #[serde(default)]
    pub saturated_dimensions: Vec<String>,
}

/// The typed alert payload a Stellar Alerts webhook delivers, discriminated
/// by its `event` field. Deserializing into this type (rather than raw
/// `serde_json::Value`) lets a consumer `match` on the alert kind instead
/// of hand-checking string fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum StellarAlertEvent {
    #[serde(rename = "payment.received")]
    PaymentReceived(PaymentAlert),
    #[serde(rename = "payment.alert")]
    PaymentAlert(PaymentAlert),
    #[serde(rename = "soroban.contract_event")]
    SorobanContractEvent(SorobanEvent),
    #[serde(rename = "soroban.host_saturation_alert")]
    SorobanHostSaturationAlert(SorobanSaturationAlert),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_a_payment_received_event() {
        let json = r#"{
            "event": "payment.received",
            "payment_id": "pay_1",
            "tx_hash": "abc123",
            "wallet_id": "wallet_1",
            "amount": "100.0000000",
            "asset": "XLM",
            "from_address": "GABC...",
            "received_at": "2026-01-01T00:00:00Z"
        }"#;

        let event: StellarAlertEvent = serde_json::from_str(json).unwrap();
        match event {
            StellarAlertEvent::PaymentReceived(alert) => {
                assert_eq!(alert.payment_id, "pay_1");
                assert_eq!(alert.asset, "XLM");
                assert_eq!(alert.asset_issuer, None);
            }
            other => panic!("expected PaymentReceived, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_a_soroban_contract_event() {
        let json = r#"{
            "event": "soroban.contract_event",
            "contract_id": "CABC...",
            "ledger": 123456,
            "topic": ["transfer", "from", "to"],
            "value": { "amount": "50" }
        }"#;

        let event: StellarAlertEvent = serde_json::from_str(json).unwrap();
        match event {
            StellarAlertEvent::SorobanContractEvent(evt) => {
                assert_eq!(evt.ledger, 123456);
                assert_eq!(evt.topic, vec!["transfer", "from", "to"]);
            }
            other => panic!("expected SorobanContractEvent, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_a_soroban_host_saturation_alert() {
        let json = r#"{
            "event": "soroban.host_saturation_alert",
            "contract_id": "CA1234...",
            "severity": "CRITICAL",
            "overall_saturation_percent": 96.5,
            "saturated_dimensions": ["cpu", "write_bytes"]
        }"#;

        let event: StellarAlertEvent = serde_json::from_str(json).unwrap();
        match event {
            StellarAlertEvent::SorobanHostSaturationAlert(alert) => {
                assert_eq!(alert.contract_id, "CA1234...");
                assert_eq!(alert.severity, "CRITICAL");
                assert_eq!(alert.overall_saturation_percent, 96.5);
                assert_eq!(alert.saturated_dimensions, vec!["cpu", "write_bytes"]);
            }
            other => panic!("expected SorobanHostSaturationAlert, got {other:?}"),
        }
    }

    #[test]
    fn rejects_an_unknown_event_discriminant() {
        let json = r#"{"event": "something.unknown"}"#;
        let result: Result<StellarAlertEvent, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn round_trips_through_serialize_and_deserialize() {
        let alert = StellarAlertEvent::PaymentAlert(PaymentAlert {
            payment_id: "pay_2".to_string(),
            tx_hash: "def456".to_string(),
            wallet_id: "wallet_2".to_string(),
            amount: "25.0000000".to_string(),
            asset: "USDC".to_string(),
            asset_issuer: Some("GISSUER...".to_string()),
            from_address: "GFROM...".to_string(),
            received_at: "2026-02-02T00:00:00Z".to_string(),
            request_id: None,
            severity: Some("high".to_string()),
        });

        let json = serde_json::to_string(&alert).unwrap();
        let round_tripped: StellarAlertEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(alert, round_tripped);
    }
}
