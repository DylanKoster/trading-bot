export interface FeeProfile {
  label: string;
  assetClass: "stock" | "crypto";
  rate: number;
  min: number;
  max: number;
  fixed: number;
  monthly: number;
}

export const FEE_PROFILES: Record<string, FeeProfile> = {
  ibkr_nl_tiered: {
    label: "Interactive Brokers Netherlands - tiered stocks",
    assetClass: "stock",
    rate: 0.0005,
    min: 1.25,
    max: 29,
    fixed: 0,
    monthly: 0,
  },
  traderepublic_nl: {
    label: "Trade Republic Netherlands - single trade",
    assetClass: "stock",
    rate: 0,
    min: 0,
    max: Infinity,
    fixed: 1,
    monthly: 0,
  },
  degiro_nl_euronext: {
    label: "DEGIRO Netherlands - Euronext + handling estimate",
    assetClass: "stock",
    rate: 0,
    min: 0,
    max: Infinity,
    fixed: 3,
    monthly: 0,
  },
  kraken_spot_maker: {
    label: "Kraken Pro - spot maker, entry tier",
    assetClass: "crypto",
    rate: 0.004,
    min: 0,
    max: Infinity,
    fixed: 0,
    monthly: 0,
  },
  kraken_spot_taker: {
    label: "Kraken Pro - spot taker, entry tier",
    assetClass: "crypto",
    rate: 0.008,
    min: 0,
    max: Infinity,
    fixed: 0,
    monthly: 0,
  },
};

export function getFeeProfile(name: string): FeeProfile {
  const profile = FEE_PROFILES[name];
  if (!profile) throw new Error(`Unknown fee profile: ${name}`);
  return profile;
}

export function transactionFee(notional: number, profile: FeeProfile): number {
  const percentageFee = notional * profile.rate;
  const variableFee = Math.min(
    Math.max(percentageFee, profile.min),
    profile.max,
  );
  return variableFee + profile.fixed;
}
