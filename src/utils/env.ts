import dotenv from "dotenv";
dotenv.config();

export function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const ENV = {
  PORT: parseInt(getEnv("PORT", "3000"), 10),
  CLIO_BASE_URL: getEnv("CLIO_BASE_URL", "https://app.clio.com"),
  CLIO_API_BASE_URL: getEnv("CLIO_API_BASE_URL", "https://app.clio.com/api/v4"),
  CLIO_CLIENT_ID: getEnv("CLIO_CLIENT_ID", ""),
  CLIO_CLIENT_SECRET: getEnv("CLIO_CLIENT_SECRET", ""),
  CLIO_REDIRECT_URI: getEnv("CLIO_REDIRECT_URI", "http://localhost:3000/oauth/callback"),
  get CLIO_ACCESS_TOKEN() { return process.env.CLIO_ACCESS_TOKEN ?? ""; },
  get CLIO_REFRESH_TOKEN() { return process.env.CLIO_REFRESH_TOKEN ?? ""; },
};
