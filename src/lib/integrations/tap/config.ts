export type TapConfig = {
  apiBaseUrl: string;
  apiKey: string;
  productReferenceMetadataKey: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Tap.`);
  return value;
}

/** Tap credentials stay server-only; PLAYBOOK only retrieves provider records. */
export function getTapConfig(env: NodeJS.ProcessEnv = process.env): TapConfig {
  return {
    apiBaseUrl: env.TAP_API_BASE_URL?.trim() || "https://api.tap.company",
    apiKey: required(env, "TAP_API_KEY"),
    // Use `product` only if Tap's direct charge.product value is the stable
    // source reference approved by Finance; otherwise use the exact metadata key.
    productReferenceMetadataKey: env.TAP_PRODUCT_REFERENCE_METADATA_KEY?.trim() || "product_id",
  };
}
