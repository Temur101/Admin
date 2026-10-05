import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface PhoneValidationResult {
  isValid: boolean;
  normalized?: string;
  error?: string;
}

/**
 * Parses and normalizes phone number to E.164 format.
 * Supports Uzbekistan local formats (901234567, 8 90 123 45 67),
 * standard format (+998 90 123 45 67), and international numbers.
 */
export function parseAndNormalizePhone(
  rawInput: string | null | undefined,
  defaultCountry: CountryCode = "UZ",
): PhoneValidationResult {
  if (!rawInput || typeof rawInput !== "string") {
    return { isValid: false, error: "empty_input" };
  }

  const trimmed = rawInput.trim();
  if (trimmed.length < 5 || trimmed.length > 30) {
    return { isValid: false, error: "invalid_length" };
  }

  // Reject non-phone characters (letters, punctuation/symbols other than +, -, (), ., space)
  if (/[^\d\s+\-().]/.test(trimmed)) {
    return { isValid: false, error: "contains_invalid_characters" };
  }

  // Normalize legacy CIS/Uzbekistan 8-prefixed 10-digit format (e.g. 8 90 123 45 67)
  let candidate = trimmed;
  const digitsOnly = candidate.replace(/\D/g, "");

  if (digitsOnly.startsWith("8") && digitsOnly.length === 10 && defaultCountry === "UZ") {
    candidate = `+998${digitsOnly.slice(1)}`;
  } else if (!candidate.startsWith("+") && digitsOnly.length === 9 && defaultCountry === "UZ") {
    // 9 digits without country code (e.g. 90 123 45 67)
    candidate = `+998${digitsOnly}`;
  } else if (!candidate.startsWith("+") && digitsOnly.startsWith("998") && digitsOnly.length === 12) {
    candidate = `+${digitsOnly}`;
  }

  try {
    const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
    if (parsed && parsed.isValid()) {
      return {
        isValid: true,
        normalized: parsed.number, // E.164 (+998901234567)
      };
    }
  } catch {
    return { isValid: false, error: "parse_error" };
  }

  return { isValid: false, error: "invalid_phone" };
}
