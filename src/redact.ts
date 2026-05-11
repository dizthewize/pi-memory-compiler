import { loadConfig } from "./config.js";

export function redactSecrets(text: string): string {
  const config = loadConfig();
  let result = text;
  for (const pattern of config.redactionPatterns) {
    try {
      const re = new RegExp(pattern, "gi");
      result = result.replace(re, (match) => {
        const key = match.split(/[=:]/)[0];
        return `${key}=[REDACTED]`;
      });
    } catch {
      // Skip invalid regex patterns
    }
  }
  return result;
}
