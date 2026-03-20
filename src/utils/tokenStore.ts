import https from "https";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

async function persistToRailway(access: string, refresh: string): Promise<void> {
    const token = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!token || !projectId || !environmentId || !serviceId) return;

  const body = JSON.stringify({
        query: `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
              variableCollectionUpsert(input: $input)
                  }`,
        variables: {
                input: {
                          projectId,
                          environmentId,
                          serviceId,
                          variables: {
                                      CLIO_ACCESS_TOKEN: access,
                                      CLIO_REFRESH_TOKEN: refresh,
                          },
                },
        },
  });

  await new Promise<void>((resolve, reject) => {
        const req = https.request(
                RAILWAY_API_URL,
          {
                    method: "POST",
                    headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${token}`,
                    },
          },
                (res) => {
                          res.resume();
                          res.on("end", resolve);
                }
              );
        req.on("error", reject);
        req.write(body);
        req.end();
  });
}

export async function persistTokens(access: string, refresh: string): Promise<void> {
    process.env.CLIO_ACCESS_TOKEN = access;
    process.env.CLIO_REFRESH_TOKEN = refresh;
    await persistToRailway(access, refresh).catch((err) =>
          console.error("[tokenStore] Failed to persist tokens to Railway:", err)
                                                    );
}

export function getAccessToken(): string {
    return process.env.CLIO_ACCESS_TOKEN ?? "";
}

export function getRefreshToken(): string {
    return process.env.CLIO_REFRESH_TOKEN ?? "";
}
