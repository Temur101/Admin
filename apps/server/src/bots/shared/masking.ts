/**
 * Masking utilities for Shadow Lead / Expired Subscription gate.
 * When a bot's subscription is not active (EXPIRED, GRACE_PERIOD, BLOCKED),
 * contact details are masked so the admin sees the lead opportunity but must
 * subscribe/pay to unlock the raw contact information.
 */

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  // Uzbekistan 12-digit standard: 998901234567 -> +998 90 *** ** 67
  if (digits.length === 12 && digits.startsWith("998")) {
    const operator = digits.slice(3, 5);
    const lastTwo = digits.slice(10);
    return `+998 ${operator} *** ** ${lastTwo}`;
  }

  // Uzbekistan 9-digit local standard: 901234567 -> +998 90 *** ** 67
  if (digits.length === 9) {
    const operator = digits.slice(0, 2);
    const lastTwo = digits.slice(7);
    return `+998 ${operator} *** ** ${lastTwo}`;
  }

  // Fallback for international / other numbers (>= 7 digits)
  if (digits.length >= 7) {
    const prefix = digits.slice(0, 4);
    const suffix = digits.slice(-2);
    return `+${prefix} *** ** ${suffix}`;
  }

  return "***";
}

export function maskName(_name?: string | null): string {
  return "***";
}

export function maskUsername(username?: string | null): string {
  if (!username) return "***";
  return "@***";
}
