import { randomBytes } from "node:crypto";

// Excludes 0/O/1/I/L so codes are easy to read and type correctly.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateShortCode(length = 6) {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}
