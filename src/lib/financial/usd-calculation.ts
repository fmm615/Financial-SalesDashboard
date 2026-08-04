const decimalPattern = /^(\d+)(?:\.(\d+))?$/;

type Decimal = { value: bigint; scale: number };

function parseDecimal(value: string, maximumScale: number): Decimal | null {
  const match = decimalPattern.exec(value.trim());
  if (!match) return null;

  const fraction = match[2] ?? "";
  if (fraction.length > maximumScale) return null;
  return { value: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function powerOfTen(exponent: number): bigint {
  return BigInt(`1${"0".repeat(exponent)}`);
}

function formatMoney(value: bigint): string {
  const whole = value / powerOfTen(6);
  const fraction = (value % powerOfTen(6)).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Multiplies the original recognised amount by the USD FX rate using integer
 * arithmetic. The stored USD result is rounded half-up to the database's six
 * decimal money places, never using JavaScript floating point.
 */
export function calculateUsdAmount(recognisedAmount: string, exchangeRateToUsd: string): string | null {
  const amount = parseDecimal(recognisedAmount, 6);
  const rate = parseDecimal(exchangeRateToUsd, 10);
  if (!amount || !rate) return null;

  const product = amount.value * rate.value;
  const productScale = amount.scale + rate.scale;
  if (productScale <= 6) return formatMoney(product * powerOfTen(6 - productScale));

  const divisor = powerOfTen(productScale - 6);
  const quotient = product / divisor;
  const remainder = product % divisor;
  return formatMoney(remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient);
}
