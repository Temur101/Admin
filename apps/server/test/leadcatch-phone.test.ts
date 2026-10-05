import { describe, expect, it } from "vitest";
import { parseAndNormalizePhone } from "../src/bots/leadcatch/phone.js";

describe("Stage 4: LeadCatch Phone Parser (35+ format table test)", () => {
  const testCases: Array<{
    input: string | null | undefined;
    expectedValid: boolean;
    expectedNormalized?: string;
    description: string;
  }> = [
    // --- Uzbekistan standard and local formats ---
    {
      input: "+998901234567",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "standard E.164 Uzbekistan format",
    },
    {
      input: "+998 90 123 45 67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "spaced Uzbekistan format",
    },
    {
      input: "+998 (90) 123-45-67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "parentheses and dashes",
    },
    {
      input: "998901234567",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "without leading plus",
    },
    {
      input: "901234567",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "9 digits local mobile",
    },
    {
      input: "90 123 45 67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "9 digits spaced",
    },
    {
      input: "(90) 123-45-67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "9 digits with parentheses and dashes",
    },
    {
      input: "8 90 123 45 67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "legacy 8-prefixed spaced",
    },
    {
      input: "8901234567",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "legacy 8-prefixed compact",
    },
    {
      input: "8 (90) 123-45-67",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "legacy 8 with parens",
    },
    {
      input: "93 987 65 43",
      expectedValid: true,
      expectedNormalized: "+998939876543",
      description: "Ucell 93 prefix",
    },
    {
      input: "+998 99 876 54 32",
      expectedValid: true,
      expectedNormalized: "+998998765432",
      description: "Uzmobile 99 prefix",
    },
    {
      input: "+998 33 111 22 33",
      expectedValid: true,
      expectedNormalized: "+998331112233",
      description: "Humans 33 prefix",
    },
    {
      input: "+998 88 555 44 33",
      expectedValid: true,
      expectedNormalized: "+998885554433",
      description: "Mobiuz 88 prefix",
    },
    {
      input: "88 555 44 33",
      expectedValid: true,
      expectedNormalized: "+998885554433",
      description: "88 prefix local",
    },
    {
      input: "+998 71 200 00 00",
      expectedValid: true,
      expectedNormalized: "+998712000000",
      description: "Tashkent landline with +998",
    },
    {
      input: "71 200 00 00",
      expectedValid: true,
      expectedNormalized: "+998712000000",
      description: "Tashkent landline local",
    },
    {
      input: "+998 97 123 45 67",
      expectedValid: true,
      expectedNormalized: "+998971234567",
      description: "Mobiuz 97 prefix",
    },
    {
      input: "+998 95 123 45 67",
      expectedValid: true,
      expectedNormalized: "+998951234567",
      description: "Uzmobile 95 prefix",
    },
    {
      input: "   90 123 45 67   ",
      expectedValid: true,
      expectedNormalized: "+998901234567",
      description: "leading and trailing whitespace",
    },

    // --- International formats ---
    {
      input: "+7 999 123 45 67",
      expectedValid: true,
      expectedNormalized: "+79991234567",
      description: "Russian mobile number",
    },
    {
      input: "+7 (999) 123-45-67",
      expectedValid: true,
      expectedNormalized: "+79991234567",
      description: "Russian mobile with parens and dashes",
    },
    {
      input: "+1 202 555 0123",
      expectedValid: true,
      expectedNormalized: "+12025550123",
      description: "US international number",
    },
    {
      input: "+44 20 7946 0958",
      expectedValid: true,
      expectedNormalized: "+442079460958",
      description: "UK international number",
    },
    {
      input: "+971 50 123 4567",
      expectedValid: true,
      expectedNormalized: "+971501234567",
      description: "UAE international number",
    },

    // --- Invalid inputs and garbage strings ---
    {
      input: "",
      expectedValid: false,
      description: "empty string",
    },
    {
      input: "   ",
      expectedValid: false,
      description: "whitespace only",
    },
    {
      input: null,
      expectedValid: false,
      description: "null value",
    },
    {
      input: undefined,
      expectedValid: false,
      description: "undefined value",
    },
    {
      input: "привет",
      expectedValid: false,
      description: "Russian text",
    },
    {
      input: "hello world",
      expectedValid: false,
      description: "English text",
    },
    {
      input: "12345",
      expectedValid: false,
      description: "too short number",
    },
    {
      input: "998",
      expectedValid: false,
      description: "country code only",
    },
    {
      input: "0000000000",
      expectedValid: false,
      description: "all zeroes",
    },
    {
      input: "+998 00 000 00 00",
      expectedValid: false,
      description: "invalid Uzbekistan mobile prefix",
    },
    {
      input: "90 123 45 6",
      expectedValid: false,
      description: "8 digits (1 digit missing)",
    },
    {
      input: "90 123 45 6789",
      expectedValid: false,
      description: "too many digits without country code",
    },
    {
      input: "++998901234567",
      expectedValid: false,
      description: "double plus",
    },
    {
      input: "90-123-45-67!?",
      expectedValid: false,
      description: "punctuation garbage symbols",
    },
  ];

  testCases.forEach((tc, idx) => {
    it(`${idx + 1}. [${tc.description}] should handle '${tc.input}'`, () => {
      const result = parseAndNormalizePhone(tc.input);
      expect(result.isValid).toBe(tc.expectedValid);
      if (tc.expectedValid) {
        expect(result.normalized).toBe(tc.expectedNormalized);
      }
    });
  });
});
