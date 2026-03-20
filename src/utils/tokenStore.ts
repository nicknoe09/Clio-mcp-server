import fs from "fs";
import path from "path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

export function persistTokens(access: string, refresh: string): void {
  process.env.CLIO_ACCESS_TOKEN = access;
  process.env.CLIO_REFRESH_TOKEN = refresh;

  try {
    if (fs.existsSync(ENV_PATH)) {
      let env = fs.readFileSync(ENV_PATH, "utf8");
      env = env.replace(/CLIO_ACCESS_TOKEN=.*/, `CLIO_ACCESS_TOKEN=${access}`);
      env = env.replace(/CLIO_REFRESH_TOKEN=.*/, `CLIO_REFRESH_TOKEN=${refresh}`);
      fs.writeFileSync(ENV_PATH, env);
    }
  } catch {
    // In production (e.g. Railway), .env may not exist — tokens live in process.env only
  }
}

export function getAccessToken(): string {
  return process.env.CLIO_ACCESS_TOKEN ?? "";
}

export function getRefreshToken(): string {
  return process.env.CLIO_REFRESH_TOKEN ?? "";
}
