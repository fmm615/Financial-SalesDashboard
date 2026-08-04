export type StripeConfig = {
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  productReferenceMetadataKey: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Stripe.`);
  return value;
}

/** Stripe credentials stay server-only; PLAYBOOK only reads Stripe records. */
export function getStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  return {
    apiBaseUrl: env.STRIPE_API_BASE_URL?.trim() || "https://api.stripe.com",
    apiKey: required(env, "STRIPE_API_KEY"),
    webhookSecret: required(env, "STRIPE_WEBHOOK_SECRET"),
    productReferenceMetadataKey: env.STRIPE_PRODUCT_REFERENCE_METADATA_KEY?.trim() || "product_id",
  };
}
