//! Sybil resistance: outcome-ledger entries are weighted by counterparty
//! diversity and stake size, not raw count, so a cluster of related/colluding
//! wallets manufacturing fake positive outcomes for each other does not move
//! a score materially (spec §5.5). Treated as adversarial and ongoing, not a
//! solved checkbox — these heuristics are expected to need revisiting.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct OutcomeSource {
    pub requester_wallet: String,
    /// Escrow amount for this entry, in a common reference unit (e.g. USDT).
    pub escrow_amount: f64,
}

/// Escrow amount at/above which stake size no longer adds extra weight — a
/// $50 task and a $5,000 task shouldn't have arbitrarily divergent influence.
pub const STAKE_REFERENCE_AMOUNT: f64 = 200.0;

/// Per-entry weight: `1/k` where k = how many entries from this same wallet
/// are in the batch — a wallet that shows up k times contributes exactly one
/// distinct-counterparty's worth of evidence in total, not k's worth (spec
/// §5.5: weighted by counterparty diversity, "not raw count"), scaled by a
/// stake-size factor capped at 1.0, and discounted further if the wallet has
/// been flagged into a sybil cluster by wallet-clustering heuristics.
pub fn diversity_weights(entries: &[OutcomeSource], flagged_wallets: &HashSet<String>) -> Vec<f64> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for e in entries {
        *counts.entry(e.requester_wallet.as_str()).or_insert(0) += 1;
    }

    entries
        .iter()
        .map(|e| {
            let k = *counts.get(e.requester_wallet.as_str()).unwrap_or(&1) as f64;
            let repetition_discount = 1.0 / k;
            let stake_factor = (e.escrow_amount.max(0.0) / STAKE_REFERENCE_AMOUNT).min(1.0);
            let cluster_discount = if flagged_wallets.contains(&e.requester_wallet) {
                0.25
            } else {
                1.0
            };
            repetition_discount * stake_factor.max(0.05) * cluster_discount
        })
        .collect()
}

/// Effective distinct-counterparty count after diversity weighting — feeds the
/// composite score's evidence-count gate so a handful of high-visibility
/// outcomes from one or two wallets can't alone reach "proven" (spec §9).
pub fn effective_evidence_count(entries: &[OutcomeSource], flagged_wallets: &HashSet<String>) -> f64 {
    diversity_weights(entries, flagged_wallets).iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet(addr: &str, amount: f64) -> OutcomeSource {
        OutcomeSource {
            requester_wallet: addr.to_string(),
            escrow_amount: amount,
        }
    }

    #[test]
    fn distinct_wallets_get_full_repetition_weight() {
        let entries = vec![wallet("0xa", 200.0), wallet("0xb", 200.0), wallet("0xc", 200.0)];
        let weights = diversity_weights(&entries, &HashSet::new());
        for w in weights {
            assert!((w - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn repeated_wallet_is_discounted() {
        let entries = vec![wallet("0xa", 200.0), wallet("0xa", 200.0), wallet("0xa", 200.0)];
        let weights = diversity_weights(&entries, &HashSet::new());
        // Same wallet 3x -> counts as exactly one distinct counterparty's worth.
        let sum: f64 = weights.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9);
    }

    #[test]
    fn flagged_cluster_wallet_is_heavily_discounted() {
        let entries = vec![wallet("0xbad", 200.0)];
        let mut flagged = HashSet::new();
        flagged.insert("0xbad".to_string());
        let weights = diversity_weights(&entries, &flagged);
        assert!((weights[0] - 0.25).abs() < 1e-9);
    }

    #[test]
    fn small_stake_contributes_less_than_reference_stake() {
        let entries = vec![wallet("0xa", 1.0), wallet("0xb", STAKE_REFERENCE_AMOUNT)];
        let weights = diversity_weights(&entries, &HashSet::new());
        assert!(weights[0] < weights[1]);
    }

    #[test]
    fn sybil_cluster_cannot_manufacture_high_effective_count() {
        // 20 outcomes, all from 2 colluding wallets -> effective count should be
        // far below 20, not close to it.
        let mut entries = vec![];
        for i in 0..20 {
            entries.push(wallet(if i % 2 == 0 { "0xcollude1" } else { "0xcollude2" }, 200.0));
        }
        let n = effective_evidence_count(&entries, &HashSet::new());
        assert!(n < 5.0, "effective count {n} should be heavily discounted for 2-wallet collusion");
    }
}
